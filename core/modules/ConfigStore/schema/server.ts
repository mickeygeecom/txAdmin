import { z, type RefinementCtx } from "zod";
import { typeDefinedConfig, typeNullableConfig } from "./utils";
import { SYM_FIXER_DEFAULT, SYM_FIXER_FATAL } from "@lib/symbols";


const dataPath = typeNullableConfig({
    name: 'Server Data Path',
    default: null,
    validator: z.string().min(1).nullable(),
    fixer: SYM_FIXER_FATAL,
});

const cfgPath = typeDefinedConfig({
    name: 'CFG File Path',
    default: 'server.cfg',
    validator: z.string().min(1),
    fixer: SYM_FIXER_FATAL,
});

const startupArgs = typeDefinedConfig({
    name: 'Startup Arguments',
    default: [],
    validator: z.string().array(),
    fixer: SYM_FIXER_DEFAULT,
});

const onesync = typeDefinedConfig({
    name: 'OneSync',
    default: 'on',
    validator: z.enum(['on', 'legacy', 'off']),
    fixer: SYM_FIXER_FATAL,
});

const autoStart = typeDefinedConfig({
    name: 'Autostart',
    default: true,
    validator: z.boolean(),
    fixer: SYM_FIXER_DEFAULT,
});

const quiet = typeDefinedConfig({
    name: 'Quiet Mode',
    default: false,
    validator: z.boolean(),
    fixer: SYM_FIXER_DEFAULT,
});

const shutdownNoticeDelayMs = typeDefinedConfig({
    name: 'Shutdown Notice Delay',
    default: 5000,
    validator: z.number().int().min(0).max(60_000),
    fixer: SYM_FIXER_DEFAULT,
});

const restartSpawnDelayMs = typeDefinedConfig({
    name: 'Restart Spawn Delay',
    default: 500,
    validator: z.number().int().min(0).max(15_000),
    fixer: SYM_FIXER_DEFAULT,
});

const restartScriptDefault = {
    enabled: false,
    scriptPath: '',
    workingDirectory: '',
    args: '',
    messagePattern: 'restart',
    delayMs: 2000,
} as const;

const NULL_CHAR_REGEX = new RegExp(String.fromCharCode(0), 'g');

const restartScript = typeDefinedConfig({
    name: 'Restart Script',
    default: restartScriptDefault,
    validator: z.object({
        enabled: z.boolean(),
        scriptPath: z.string(),
        workingDirectory: z.string(),
        args: z.string(),
        messagePattern: z.string(),
        delayMs: z.number().int().min(0).max(300_000),
    }).superRefine((value: typeof restartScriptDefault, ctx: RefinementCtx) => {
        if (value.enabled && !value.scriptPath.trim().length) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'Script path is required when the restart script is enabled.',
            });
        }
    }),
    fixer: (input: any) => {
        const source = (typeof input === 'object' && input !== null)
            ? input as Partial<typeof restartScriptDefault>
            : {};

        const toBool = (value: unknown, fallback: boolean) => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const lowered = value.trim().toLowerCase();
                if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
                if (['false', '0', 'no', 'off'].includes(lowered)) return false;
            }
            if (typeof value === 'number') return value !== 0;
            return fallback;
        };

        const toString = (value: unknown, fallback: string, allowEmpty = true, defaultWhenEmpty?: string) => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (!trimmed.length && !allowEmpty) {
                    return defaultWhenEmpty ?? fallback;
                }
                return trimmed;
            }
            return fallback;
        };

        const toDelay = (value: unknown, fallback: number) => {
            let num: number;
            if (typeof value === 'number') {
                num = value;
            } else if (typeof value === 'string') {
                num = Number(value.trim());
            } else {
                num = NaN;
            }
            if (!Number.isFinite(num)) return fallback;
            return Math.max(0, Math.min(300_000, Math.round(num)));
        };

    const clean = (str: string) => str.replace(NULL_CHAR_REGEX, '');
        const sanitized = {
            enabled: toBool(source.enabled, restartScriptDefault.enabled),
            scriptPath: clean(toString(source.scriptPath, restartScriptDefault.scriptPath)),
            workingDirectory: clean(toString(source.workingDirectory, restartScriptDefault.workingDirectory)),
            args: clean(toString(source.args, restartScriptDefault.args)),
            messagePattern: clean(toString(
                source.messagePattern,
                restartScriptDefault.messagePattern,
            )),
            delayMs: toDelay(source.delayMs, restartScriptDefault.delayMs),
        };

        if (!sanitized.enabled) {
            sanitized.scriptPath = sanitized.scriptPath ?? '';
        }

        return sanitized;
    },
});


export default {
    dataPath,
    cfgPath,
    startupArgs,
    onesync,
    autoStart,
    quiet,
    shutdownNoticeDelayMs,
    restartSpawnDelayMs,
    restartScript,
} as const;
