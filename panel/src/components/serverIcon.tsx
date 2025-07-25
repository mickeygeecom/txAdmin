import { cn } from "@/lib/utils";
import { AvatarFallback, AvatarImage, Avatar as ShadcnAvatar } from "./ui/avatar";
import { useImageCache } from "@/hooks/useImageCache";


type ServerIconProps = {
    serverName?: string;
    gameName?: string;
    iconFilename?: string;
    className?: string;
    extraClasses?: string;
};

export function ServerIcon({ serverName, gameName, iconFilename, className, extraClasses }: ServerIconProps) {
    let fallbackUrl: string;
    if (gameName === 'fivem') {
        fallbackUrl = '/img/fivem-server-icon.png';
    } else if (gameName === 'redm') {
        fallbackUrl = '/img/redm-server-icon.png';
    } else {
        fallbackUrl = '/img/unknown-server-icon.png';
    }

    let iconUrl = fallbackUrl;
    if (iconFilename && /^icon-([a-f0-9]{16})\.png$/.test(iconFilename)) {
        iconUrl = `/.runtime/${iconFilename}`;
    }

    // Cache both the main icon and fallback
    const cachedIcon = useImageCache(iconUrl);
    const cachedFallback = useImageCache(fallbackUrl);
    
    return (
        <ShadcnAvatar className={cn(className, extraClasses)}>
            <AvatarImage
                src={cachedIcon.src}
                alt={serverName}
            />
            <AvatarFallback asChild>
                <img src={cachedFallback.src} className="aspect-square rounded-md h-full w-full" />
            </AvatarFallback>
        </ShadcnAvatar>
    );
}

export function ServerGlowIcon(props: Omit<ServerIconProps, 'extraClasses'>) {
    return (
        <div className="relative flex shrink-0">
            <ServerIcon {...props} extraClasses="size-14 xs:size-16 rounded-md z-10" />
            <ServerIcon {...props} extraClasses="size-14 xs:size-16 absolute blur-lg z-0 scale-90" />
        </div>
    );
}
