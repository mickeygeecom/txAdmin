import { getPublicIp } from "@core/boot/startReadyWatcher";
import type { AdvancedCommandHandler } from "../runCommand";
import probeInternetTime from "@lib/host/probeInternetTime";
import { mdCodeBlock } from "@lib/misc";


const printPublicIp: AdvancedCommandHandler = async (ctx, args) => {
    const ip = await getPublicIp() || 'not found';
    return {
        type: 'md',
        data: `Public IP: ${ip}`,
    }
}


const printClockInfo: AdvancedCommandHandler = async (ctx, args) => {
    const probeResult = await probeInternetTime();
    const { date, avgTimeMs, avgOffsetMs, avgRttMs, results } = probeResult;
    const internetTime = date ? new Date(date).toLocaleString() : 'not found';
    const currentTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const drift = avgOffsetMs ? `${avgOffsetMs}ms` : 'not found';
    const rtt = avgRttMs ? `${avgRttMs}ms` : 'not found';

    return {
        type: 'md',
        data: [
            '## Clock Info:',
            `- Local time: ${new Date().toLocaleString()}`,
            `- Internet time: ${internetTime}`,
            `- Timezone: ${currentTimezone}`,
            `- Drift: ${drift}`,
            `- RTT: ${rtt}`,
            '## Raw Probe Data:',
            ...results.map(r => {
                const j = JSON.stringify({ ...r, url: undefined, success: undefined }, null, 2)
                return [
                    `### ${r.url}`,
                    mdCodeBlock(j, 'json'),
                ].join('\n');
            }),
        ].join('\n'),
    }
}


export default {
    printPublicIp,
    printClockInfo,
}
