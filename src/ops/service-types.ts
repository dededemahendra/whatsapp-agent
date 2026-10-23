export interface ServiceStatus { installed: boolean; running: boolean | null; detail: string }
export interface ServiceManager {
  install(): Promise<string>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
}
