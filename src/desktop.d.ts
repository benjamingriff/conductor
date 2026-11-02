export {};
declare global {
  interface DesktopInfo {
    version: string;
    electron: string;
    channel: 'development' | 'installed';
    dataPath: string;
    appPath: string;
    launchAtLogin: boolean;
    platform: string;
  }
  interface Window {
    conductor?: {
      request: (path: string, method?: string, body?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }>;
      desktop(action: 'info'): Promise<DesktopInfo>;
      desktop(action: 'login', value: boolean): Promise<boolean>;
      desktop(action: 'show-data'): Promise<boolean>;
    };
  }
}
