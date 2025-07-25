import { LocalStorageKey } from '@/lib/localStorage';
import { useState, useEffect } from 'react';

const CACHE_PREFIX = LocalStorageKey.ImgCache;
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

type CacheEntry = {
    data: string; // base64
    timestamp: number;
};

const isExpired = (entry: CacheEntry): boolean => {
    return Date.now() - entry.timestamp > CACHE_EXPIRY;
};

const getCachedImage = (url: string): string | null => {
    try {
        const cached = localStorage.getItem(CACHE_PREFIX + url);
        if (!cached) return null;
        
        const entry: CacheEntry = JSON.parse(cached);
        if (isExpired(entry)) {
            localStorage.removeItem(CACHE_PREFIX + url);
            return null;
        }
        
        return entry.data;
    } catch {
        return null;
    }
};

const cacheImage = async (url: string): Promise<string | null> => {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch');
        
        const blob = await response.blob();
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
                const base64 = reader.result as string;
                const entry: CacheEntry = {
                    timestamp: Date.now(),
                    data: base64,
                };
                
                try {
                    localStorage.setItem(CACHE_PREFIX + url, JSON.stringify(entry));
                } catch (e) {
                    // localStorage might be full, try to clear old entries
                    clearExpiredCache();
                    try {
                        localStorage.setItem(CACHE_PREFIX + url, JSON.stringify(entry));
                    } catch {
                        // Still failed, ignore caching
                    }
                }
                
                resolve(base64);
            };
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
};

const clearExpiredCache = () => {
    try {
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(CACHE_PREFIX)) {
                try {
                    const entry: CacheEntry = JSON.parse(localStorage.getItem(key)!);
                    if (isExpired(entry)) {
                        keysToRemove.push(key);
                    }
                } catch {
                    keysToRemove.push(key);
                }
            }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
    } catch {
        // Ignore errors
    }
};

export const useImageCache = (originalSrc: string) => {
    const [src, setSrc] = useState<string>(originalSrc);
    const [isLoading, setIsLoading] = useState(true);
    
    useEffect(() => {
        if (!originalSrc) {
            setSrc(originalSrc);
            setIsLoading(false);
            return;
        }
        
        // Check cache first
        const cached = getCachedImage(originalSrc);
        if (cached) {
            setSrc(cached);
            setIsLoading(false);
            return;
        }
        
        // Try to load and cache the image
        cacheImage(originalSrc).then(cachedData => {
            if (cachedData) {
                setSrc(cachedData);
            } else {
                // Fallback to original URL if caching failed
                setSrc(originalSrc);
            }
            setIsLoading(false);
        });
        
    }, [originalSrc]);
    
    return { src, isLoading };
}; 
