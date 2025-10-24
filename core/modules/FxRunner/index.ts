import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import StreamValues from 'stream-json/streamers/StreamValues';
import { customAlphabet } from 'nanoid/non-secure';
import dict49 from 'nanoid-dictionary/nolookalikes';
import consoleFactory from '@lib/console';
import { resolveCFGFilePath, validateFixServerConfig } from '@lib/fxserver/fxsConfigHelper';
import { msToShortishDuration } from '@lib/misc';
import { SYM_SYSTEM_AUTHOR } from '@lib/symbols';
import { UpdateConfigKeySet } from '@modules/ConfigStore/utils';
import { childProcessEventBlackHole, getFxSpawnVariables, getMutableConvars, isValidChildProcess, mutableConvarConfigDependencies, setupCustomLocaleFile, stringifyConsoleArgs } from './utils';
import ProcessManager, { ChildProcessStateInfo } from './ProcessManager';
import handleFd3Messages from './handleFd3Messages';
import ConsoleLineEnum from '@modules/Logger/FXServerLogger/ConsoleLineEnum';
import { txHostConfig, txEnv } from '@core/globalData';
import path from 'node:path';
const console = consoleFactory('FxRunner');
const genMutex = customAlphabet(dict49, 5);

const MIN_KILL_DELAY = 250;


/**
 * Module responsible for handling the FXServer process.
 * 
 * FIXME: the methods that return error string should either throw or return 
 * a more detailed and better formatted object
 */
export default class FxRunner {
    static readonly configKeysWatched = [...mutableConvarConfigDependencies, 'server.restartScript'];

    public readonly history: ChildProcessStateInfo[] = [];
    private proc: ProcessManager | null = null;
    private isAwaitingShutdownNoticeDelay = false;
    private isAwaitingRestartSpawnDelay = false;
    private restartSpawnBackoffDelay = 0;


    //MARK: SIGNALS
    /**
     * Triggers a convar update
     */
    public handleConfigUpdate(updatedConfigs: UpdateConfigKeySet) {
        this.updateMutableConvars().catch(() => { });
        if (updatedConfigs.hasMatch('server.restartScript')) {
            this.syncRestartScriptConfig();
        }
    }


    /**
     * Gracefully shutdown when txAdmin gets an exit event.  
     * There is no time for a more graceful shutdown with announcements and events.  
     * Will only use the quit command and wait for the process to exit.  
     */
    public handleShutdown() {
        if (!this.proc?.isAlive || !this.proc.stdin) return null;
        this.proc.stdin.write('quit "host shutting down"\n');
        return new Promise<void>((resolve) => {
            this.proc?.onExit(resolve); //will let fxserver finish by itself
        });
    }


    /**
     * Receives the signal that all the start banner was already printed and other modules loaded
     */
    public signalStartReady() {
        if (!txConfig.server.autoStart) return;

        if (!this.isConfigured) {
            return console.warn('Please open txAdmin on the browser to configure your server.');
        }

        if (!txCore.adminStore.hasAdmins()) {
            return console.warn('The server will not auto start because there are no admins configured.');
        }

        if (txConfig.server.quiet || txHostConfig.forceQuietMode) {
            console.defer(1000).warn('FXServer Quiet mode is enabled. Access the Live Console to see the logs.');
        }

        this.spawnServer(true);
    }


    /**
     * Handles boot signals related to bind errors and sets the backoff delay.  
     * On successfull bind, the backoff delay is reset to 0.  
     * On bind error, the backoff delay is increased by 5s, up to 45s.
     * @returns the new backoff delay in ms
     */
    public signalSpawnBackoffRequired(required: boolean) {
        if (required) {
            this.restartSpawnBackoffDelay = Math.min(
                this.restartSpawnBackoffDelay + 5_000,
                45_000
            );
        } else {
            if (this.restartSpawnBackoffDelay) {
                console.verbose.debug('Server booted successfully, resetting spawn backoff delay.');
            }
            this.restartSpawnBackoffDelay = 0;
        }
        return this.restartSpawnBackoffDelay;
    }


    //MARK: SPAWN
    /**
     * Spawns the FXServer and sets up all the event handlers.
     * NOTE: Don't use txConfig in here to avoid race conditions.
     */
    public async spawnServer(shouldAnnounce = false) {
        //If txAdmin is shutting down
        if(txManager.isShuttingDown) {
            const msg = `Cannot start the server while txAdmin is shutting down.`;
            console.error(msg);
            return msg;
        }

        //If the server is already alive
        if (this.proc !== null) {
            const msg = `The server has already started.`;
            console.error(msg);
            return msg;
        }

        //Setup spawn variables & locale file
        let fxSpawnVars;
        const newServerMutex = genMutex();
        try {
            txCore.webServer.resetToken();
            fxSpawnVars = getFxSpawnVariables();
            // debugPrintSpawnVars(fxSpawnVars); //DEBUG
        } catch (error) {
            const errMsg = `Error setting up spawn variables: ${(error as any).message}`;
            console.error(errMsg);
            return errMsg;
        }
        try {
            await setupCustomLocaleFile();
        } catch (error) {
            const errMsg = `Error copying custom locale: ${(error as any).message}`;
            console.error(errMsg);
            return errMsg;
        }

        //If there is any FXServer configuration missing
        if (!this.isConfigured) {
            const msg = `Cannot start the server with missing configuration (serverDataPath || cfgPath).`;
            console.error(msg);
            return msg;
        }

        //Validating server.cfg & configuration
        let netEndpointDetected: string;
        try {
            const result = await validateFixServerConfig(fxSpawnVars.cfgPath, fxSpawnVars.dataPath);
            if (result.errors || !result.connectEndpoint) {
                const msg = `**Unable to start the server due to error(s) in your config file(s):**\n${result.errors}`;
                console.error(msg);
                return msg;
            }
            if (result.warnings) {
                const msg = `**Warning regarding your configuration file(s):**\n${result.warnings}`;
                console.warn(msg);
            }

            netEndpointDetected = result.connectEndpoint;
        } catch (error) {
            const errMsg = `server.cfg error: ${(error as any).message}`;
            console.error(errMsg);
            if ((error as any).message.includes('unreadable')) {
                console.error('That is the file where you configure your server and start resources.');
                console.error('You likely moved/deleted your server files or copied the txData folder from another server.');
                console.error('To fix this issue, open the txAdmin web interface then go to "Settings > FXServer" and fix the "Server Data Folder" and "CFG File Path".');
            }
            return errMsg;
        }

        //Reseting monitor stats
        txCore.fxMonitor.resetState();

        //Resetting frontend playerlist
        txCore.webServer.webSocket.buffer('playerlist', {
            mutex: newServerMutex,
            type: 'fullPlayerlist',
            playerlist: [],
        });

        //Announcing
        if (shouldAnnounce) {
            txCore.discordBot.sendAnnouncement({
                type: 'success',
                description: {
                    key: 'server_actions.spawning_discord',
                    data: { servername: fxSpawnVars.serverName },
                },
            });
        }

        //Starting server
        const childProc = spawn(
            fxSpawnVars.bin,
            fxSpawnVars.args,
            {
                cwd: fxSpawnVars.dataPath,
                stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
            },
        );
        if (!isValidChildProcess(childProc)) {
            const errMsg = `Failed to run \n${fxSpawnVars.bin}`;
            console.error(errMsg);
            return errMsg;
        }
        this.proc = new ProcessManager(childProc, {
            mutex: newServerMutex,
            netEndpoint: netEndpointDetected,
            onStatusUpdate: () => {
                txCore.webServer.webSocket.pushRefresh('status');
            }
        });
        txCore.logger.fxserver.logFxserverSpawn(this.proc.pid.toString());

        this.syncRestartScriptConfig();

        //Setting up StdIO
        childProc.stdout.setEncoding('utf8');
        childProc.stdout.on('data',
            txCore.logger.fxserver.writeFxsOutput.bind(
                txCore.logger.fxserver,
                ConsoleLineEnum.StdOut,
            ),
        );
        childProc.stderr.on('data',
            txCore.logger.fxserver.writeFxsOutput.bind(
                txCore.logger.fxserver,
                ConsoleLineEnum.StdErr,
            ),
        );
        const jsoninPipe = childProc.stdio[3].pipe(StreamValues.withParser() as any);
        jsoninPipe.on('data', handleFd3Messages.bind(null, newServerMutex));

        //_Almost_ don't care
        childProc.stdin.on('error', childProcessEventBlackHole);
        childProc.stdin.on('data', childProcessEventBlackHole);
        childProc.stdout.on('error', childProcessEventBlackHole);
        childProc.stderr.on('error', childProcessEventBlackHole);
        childProc.stdio[3].on('error', childProcessEventBlackHole);

        //FIXME: return a more detailed object
        return null;
    }


    private syncRestartScriptConfig() {
        if (!this.proc?.isAlive) return;
        const cfg = txConfig.server.restartScript;
        if (!cfg) return;
        this.sendEvent('restartScriptConfig', {
            enabled: !!cfg.enabled,
            scriptPath: cfg.scriptPath ?? '',
            workingDirectory: cfg.workingDirectory ?? '',
            args: cfg.args ?? '',
            messagePattern: cfg.messagePattern ?? '',
            delayMs: Number.isFinite(cfg.delayMs) ? cfg.delayMs : 0,
        });
    }


    private maybeLaunchRestartScript(
        shutdownMessage: string | undefined,
        isRestarting: boolean,
        reason?: string,
    ) {
        const cfg = txConfig.server.restartScript;
        if (!cfg?.enabled) return;
        if (!txEnv.isWindows) {
            console.warn('Restart script is enabled but only supported on Windows hosts. Skipping execution.');
            return;
        }

        const rawScriptPath = (cfg.scriptPath ?? '').trim();
        if (!rawScriptPath.length) {
            console.warn('Restart script is enabled but the batch file path is empty.');
            return;
        }

        const normalizedScriptPath = path.normalize(rawScriptPath.replace(/^"+|"+$/g, ''));
        if (!path.isAbsolute(normalizedScriptPath)) {
            console.warn(`Restart script path must be absolute. Received: ${normalizedScriptPath}`);
            return;
        }

        const pattern = (cfg.messagePattern ?? '').trim().toLowerCase();
        if (pattern) {
            const matchSources: string[] = [];
            if (shutdownMessage) matchSources.push(shutdownMessage);
            if (reason) matchSources.push(reason);
            if (isRestarting) matchSources.push('restart');
            const hasPatternMatch = matchSources.some((text) => text.toLowerCase().includes(pattern));
            if (!hasPatternMatch) {
                console.verbose.debug('Restart script skipped because the shutdown context did not match the configured pattern.');
                return;
            }
        } else if (!isRestarting) {
            console.verbose.debug('Restart script skipped: pattern is blank and this shutdown is not a restart.');
            return;
        }

        const delayMs = Number.isFinite(cfg.delayMs) ? Math.max(0, cfg.delayMs) : 0;
        const extraArgs = (cfg.args ?? '').trim();
        const commandLine = this.buildRestartScriptCommand(normalizedScriptPath, extraArgs);

        const rawCwd = (cfg.workingDirectory ?? '').trim();
        let resolvedCwd: string | undefined;
        if (rawCwd.length) {
            const normalizedCwd = path.normalize(rawCwd.replace(/^"+|"+$/g, ''));
            resolvedCwd = path.isAbsolute(normalizedCwd)
                ? normalizedCwd
                : (txConfig.server.dataPath
                    ? path.normalize(path.resolve(txConfig.server.dataPath, normalizedCwd))
                    : path.normalize(path.resolve(normalizedCwd)));
        } else if (txConfig.server.dataPath) {
            resolvedCwd = path.normalize(txConfig.server.dataPath);
        }

        const runScript = async () => {
            try {
                await fsp.access(normalizedScriptPath, fsConstants.F_OK);
            } catch (error) {
                console.warn(`Restart script not found: ${normalizedScriptPath}`);
                return;
            }

            try {
                const child = spawn('cmd.exe', ['/c', commandLine], {
                    cwd: resolvedCwd,
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true,
                });
                child.on('error', (error) => {
                    console.error(`Failed to start restart script (${normalizedScriptPath}): ${(error as Error).message}`);
                });
                child.unref();
                const triggerKind = isRestarting ? 'restart' : 'shutdown';
                console.ok(`Launched restart script${delayMs ? ` after ${delayMs}ms` : ''} (${triggerKind}): ${normalizedScriptPath}`);
            } catch (error) {
                console.error(`Failed to launch restart script (${normalizedScriptPath}): ${(error as Error).message}`);
            }
        };

        if (delayMs > 0) {
            const timeout = setTimeout(() => {
                void runScript();
            }, delayMs);
            timeout.unref?.();
            console.verbose.debug(`Restart script scheduled to run in ${delayMs}ms.`);
        } else {
            void runScript();
        }
    }


    private buildRestartScriptCommand(scriptPath: string, extraArgs: string) {
        const needsQuotes = /\s/.test(scriptPath);
        const quotedPath = needsQuotes ? `"${scriptPath}"` : scriptPath;
        const trimmedArgs = extraArgs.trim();
        return trimmedArgs.length ? `${quotedPath} ${trimmedArgs}` : quotedPath;
    }


    //MARK: CONTROL
    /**
     * Restarts the FXServer
     */
    public async restartServer(reason: string, author: string | typeof SYM_SYSTEM_AUTHOR) {
        //Prevent concurrent restart request
        const respawnDelay = this.restartSpawnDelay;
        if (this.isAwaitingRestartSpawnDelay) {
            const durationStr = msToShortishDuration(
                respawnDelay.ms,
                { units: ['m', 's', 'ms'] }
            );
            return `A restart is already in progress, with a delay of ${durationStr}.`;
        }

        try {
            //Restart server
            const killError = await this.killServer(reason, author, true);
            if (killError) return killError;

            //Give time for the OS to release the ports

            if (respawnDelay.isBackoff) {
                console.warn(`Restarting the fxserver with backoff delay of ${respawnDelay.ms}ms`);
            }
            this.isAwaitingRestartSpawnDelay = true;
            await sleep(respawnDelay.ms);
            this.isAwaitingRestartSpawnDelay = false;

            //Start server again :)
            return await this.spawnServer();
        } catch (error) {
            const errMsg = `Couldn't restart the server.`;
            console.error(errMsg);
            console.verbose.dir(error);
            return errMsg;
        } finally {
            //Make sure the flag is reset
            this.isAwaitingRestartSpawnDelay = false;
        }
    }


    /**
     * Kills the FXServer child process.  
     * NOTE: isRestarting might be true even if not called by this.restartServer().
     */
    public async killServer(reason: string, author: string | typeof SYM_SYSTEM_AUTHOR, isRestarting = false) {
        if (!this.proc) return null; //nothing to kill

        //Prepare vars
        const shutdownDelay = Math.max(txConfig.server.shutdownNoticeDelayMs, MIN_KILL_DELAY);
        const reasonString = reason ?? 'no reason provided';
        const messageType = isRestarting ? 'restarting' : 'stopping';
        const messageColor = isRestarting ? 'warning' : 'danger';
        const tOptions = {
            servername: txConfig.general.serverName,
            reason: reasonString,
        };
        let shutdownAnnouncement: string | undefined;

        //Prevent concurrent kill request
        if (this.isAwaitingShutdownNoticeDelay) {
            const durationStr = msToShortishDuration(
                shutdownDelay,
                { units: ['m', 's', 'ms'] }
            );
            return `A shutdown is already in progress, with a delay of ${durationStr}.`;
        }

        try {
            //If the process is alive, send warnings event and await the delay
            if (this.proc.isAlive) {
                shutdownAnnouncement = txCore.translator.t(`server_actions.${messageType}`, tOptions);
                this.sendEvent('serverShuttingDown', {
                    delay: txConfig.server.shutdownNoticeDelayMs,
                    author: typeof author === 'string' ? author : 'txAdmin',
                    message: shutdownAnnouncement,
                });
                this.isAwaitingShutdownNoticeDelay = true;
                await sleep(shutdownDelay);
                this.isAwaitingShutdownNoticeDelay = false;
            }

            //Stopping server
            this.proc.destroy();
            const debugInfo = this.proc.stateInfo;
            this.history.push(debugInfo);
            this.proc = null;

            this.maybeLaunchRestartScript(shutdownAnnouncement, isRestarting, reasonString);

            //Cleanup
            txCore.fxScheduler.handleServerClose();
            txCore.fxResources.handleServerClose();
            txCore.fxPlayerlist.handleServerClose(debugInfo.mutex);
            txCore.metrics.svRuntime.logServerClose(reasonString);
            txCore.discordBot.sendAnnouncement({
                type: messageColor,
                description: {
                    key: `server_actions.${messageType}_discord`,
                    data: tOptions,
                },
            }).catch(() => { });
            return null;
        } catch (error) {
            const msg = `Couldn't kill the server. Perhaps What Is Dead May Never Die.`;
            console.error(msg);
            console.verbose.dir(error);
            this.proc = null;
            return msg;
        } finally {
            //Make sure the flag is reset
            this.isAwaitingShutdownNoticeDelay = false;
        }
    }


    //MARK: COMMANDS
    /**
     * Resets the convars in the server.
     * Useful for when we change txAdmin settings and want it to reflect on the server.
     * This will also fire the `txAdmin:event:configChanged`
     */
    private async updateMutableConvars() {
        console.log('Updating FXServer ConVars.');
        try {
            await setupCustomLocaleFile();
            const convarList = getMutableConvars(false);
            for (const [set, convar, value] of convarList) {
                this.sendCommand(set, [convar, value], SYM_SYSTEM_AUTHOR);
            }
            return this.sendEvent('configChanged');
        } catch (error) {
            console.verbose.error('Error updating FXServer ConVars');
            console.verbose.dir(error);
            return false;
        }
    }


    /**
     * Fires an `txAdmin:event` inside the server via srvCmd > stdin > command > lua broadcaster.  
     * @returns true if the command was sent successfully, false otherwise.
     */
    public sendEvent(eventType: string, data = {}) {
        if (typeof eventType !== 'string' || !eventType) throw new Error('invalid eventType');
        try {
            return this.sendCommand('txaEvent', [eventType, data], SYM_SYSTEM_AUTHOR);
        } catch (error) {
            console.verbose.error(`Error writing firing server event ${eventType}`);
            console.verbose.dir(error);
            return false;
        }
    }


    /**
     * Formats and sends commands to fxserver's stdin.
     */
    public sendCommand(
        cmdName: string,
        cmdArgs: (string | number | object)[],
        author: string | typeof SYM_SYSTEM_AUTHOR
    ) {
        if (!this.proc?.isAlive) return false;
        if (typeof cmdName !== 'string' || !cmdName.length) throw new Error('cmdName is empty');
        if (!Array.isArray(cmdArgs)) throw new Error('cmdArgs is not an array');
        //NOTE: technically fxserver accepts anything but space and ; in the command name
        if (!/^\w+$/.test(cmdName)) {
            throw new Error('invalid cmdName string');
        }

        // Send the command to the server
        const rawInput = `${cmdName} ${stringifyConsoleArgs(cmdArgs)}`;
        return this.sendRawCommand(rawInput, author);
    }


    /**
     * Writes to fxchild's stdin.
     * NOTE: do not send commands with \n at the end, this function will add it.
     */
    public sendRawCommand(command: string, author: string | typeof SYM_SYSTEM_AUTHOR) {
        if (!this.proc?.isAlive) return false;
        if (typeof command !== 'string') throw new Error('Expected command as String!');
        if (author !== SYM_SYSTEM_AUTHOR && (typeof author !== 'string' || !author.length)) {
            throw new Error('Expected non-empty author as String or Symbol!');
        }
        try {
            const success = this.proc.stdin?.write(command + '\n');
            if (author === SYM_SYSTEM_AUTHOR) {
                txCore.logger.fxserver.logSystemCommand(command);
            } else {
                txCore.logger.fxserver.logAdminCommand(author, command);
            }
            return success;
        } catch (error) {
            console.error('Error writing to fxChild\'s stdin.');
            console.verbose.dir(error);
            return false;
        }
    }


    //MARK: GETTERS
    /**
     * The ChildProcessStateInfo of the current FXServer, or null
     */
    public get child() {
        return this.proc?.stateInfo;
    }


    /**
     * If the server is _supposed to_ not be running.  
     * It takes into consideration the RestartSpawnDelay.  
     * - TRUE: server never started, or failed during a start/restart.
     * - FALSE: server started, but might have been killed or crashed.
     */
    public get isIdle() {
        return !this.proc && !this.isAwaitingRestartSpawnDelay;
    }


    /**
     * True if both the serverDataPath and cfgPath are configured
     */
    public get isConfigured() {
        return typeof txConfig.server.dataPath === 'string'
            && txConfig.server.dataPath.length > 0
            && typeof txConfig.server.cfgPath === 'string'
            && txConfig.server.cfgPath.length > 0;
    }


    /**
     * The resolved paths of the server
     * FIXME: check where those paths are needed and only calculate what is relevant
     */
    public get serverPaths() {
        if (!this.isConfigured) return;
        return {
            dataPath: path.normalize(txConfig.server.dataPath!), //to maintain consistency
            cfgPath: resolveCFGFilePath(txConfig.server.cfgPath, txConfig.server.dataPath!),
        }
        // return {
        //     data: {
        //         absolute: 'xxx',
        //     },
        //     //TODO: cut paste logic from resolveCFGFilePath
        //     resources: {
        //         //???
        //     },
        //     cfg: {
        //         fileName: 'xxx',
        //         relativePath: 'xxx',
        //         absolutePath: 'xxx',
        //     }
        // };
    }


    /**
     * The duration in ms that FxRunner should wait between killing the server and starting it again.  
     * This delay is present to avoid weird issues with the OS not releasing the endpoint in time.  
     * NOTE: reminder that the config might be 0ms
     */
    public get restartSpawnDelay() {
        let ms = txConfig.server.restartSpawnDelayMs;
        let isBackoff = false;
        if (this.restartSpawnBackoffDelay >= ms) {
            ms = this.restartSpawnBackoffDelay;
            isBackoff = true;
        }

        return {
            ms,
            isBackoff,
            // isDefault: ms === ConfigStore.SchemaDefaults.server.restartSpawnDelayMs
        }
    }
};
