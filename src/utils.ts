import { join } from "node:path";

export const getRootDirectoryPath = () => {
    return join(require.main.path, '..');
};

export const RES_CONFIG: Record<string, { width: number; height: number; videoBitrate: string; audioBitrate: string }> = {
    '1440p': {
        width: 2560,
        height: 1440,
        videoBitrate: '6000k',
        audioBitrate: '192k',
    },
    '2160p': {
        width: 3840,
        height: 2160,
        videoBitrate: '8000k',
        audioBitrate: '256k',
    },
    '1080p': {
        width: 1920,
        height: 1080,
        videoBitrate: '5000k',
        audioBitrate: '192k',
    },
    '720p': {
        width: 1280,
        height: 720,
        videoBitrate: '2800k',
        audioBitrate: '128k',
    },
    '480p': {
        width: 854,
        height: 480,
        videoBitrate: '1400k',
        audioBitrate: '96k',
    },
    '360p': {
        width: 640,
        height: 360,
        videoBitrate: '800k',
        audioBitrate: '96k',
    },
    '240p': {
        width: 426,
        height: 240,
        videoBitrate: '400k',
        audioBitrate: '64k',
    },
};

export const Resolutions = ['2160p', '1440p', '1080p', '720p', '360p', '480p', '240p'];
