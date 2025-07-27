import got from "@lib/got";
import { performance } from "node:perf_hooks";

type TimeProbe = { url: string; parse: (body: string) => number };

const timeProbes: TimeProbe[] = [
    {
        url: "https://time.akamai.com/?ms",
        parse: (b) => parseFloat(b.trim()) * 1000
    },
    {
        url: "https://www.cloudflare.com/cdn-cgi/trace",
        parse: (b) => {
            const tsLine = b.split("\n").find((l) => l.startsWith("ts="))!;
            const ts = parseFloat(tsLine.slice(3));        // seconds.frac
            return Math.round(ts * 1000);
        }
    },
    {
        url: "https://gettimeapi.dev/v1/time",
        parse: (b) => {
            const json = JSON.parse(b);
            return Date.parse(json.date + 'T' + json.time + 'Z');
        }
    }
];


type ProbeSuccess = {
    url: string;
    success: true;
    serverTime: number;
    rtt: number;
    offset: number;
};
type ProbeFailure = {
    url: string;
    success: false;
    error: string;
}
type ProbeResult = ProbeSuccess | ProbeFailure;

const runProbe = async ({ url, parse }: TimeProbe): Promise<ProbeResult> => {
    const timeoutMs = 5000;
    try {
        const t0 = performance.now();
        const res = await got(url, {
            retry: { limit: 0 },
            timeout: { request: timeoutMs },
        });
        const t1 = performance.now();
        const serverTime = parse(res.body);
        const rtt = t1 - t0;
        const offset = serverTime + rtt / 2 - Date.now();
        return { url, success: true, serverTime, rtt, offset };
    } catch (error) {
        return { url, success: false, error: (error as Error)?.message ?? 'unknown error' };
    }
}


type RunAllProbesResult = {
    date: Date | null;
    avgTimeMs: number | null;
    avgOffsetMs: number | null;
    avgRttMs: number | null;
    results: ProbeResult[];
}

export default async function probeInternetTime(): Promise<RunAllProbesResult> {
    const results = await Promise.all(timeProbes.map(runProbe));
    const successResults = results.filter((r) => r.success) as ProbeSuccess[];
    const avgTimeMs = successResults.reduce((acc, r) => acc + r.serverTime, 0) / successResults.length;
    const avgOffsetMs = successResults.reduce((acc, r) => acc + r.offset, 0) / successResults.length;
    const avgRttMs = successResults.reduce((acc, r) => acc + r.rtt, 0) / successResults.length;
    return {
        date: avgTimeMs ? new Date(avgTimeMs) : null,
        avgTimeMs: Math.floor(avgTimeMs),
        avgOffsetMs: Math.floor(avgOffsetMs),
        avgRttMs: Math.floor(avgRttMs),
        results,
    };
}
