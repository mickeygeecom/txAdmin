import consoleFactory from '@lib/console';
const console = consoleFactory('ATTENTION');


//@ts-ignore esbuild will replace TX_PRERELEASE_EXPIRATION with a string
const PRERELEASE_EXPIRATION = parseInt(TX_PRERELEASE_EXPIRATION);

const printPreReleaseBanner = () => {
    console.error('This is a pre-release version of txAdmin!');
    console.error('This build is meant to be used by txAdmin beta testers.');
    console.error('Please report any issues on https://discord.gg/txAdmin.');
};

export default () => {
    if (isNaN(PRERELEASE_EXPIRATION) || PRERELEASE_EXPIRATION === 0) return;
    printPreReleaseBanner();
};
