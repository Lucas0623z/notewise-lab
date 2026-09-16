import type { Project } from "./types";

declare global {
  interface Window {
    desktop?: {
      readonly platform: "win32";
      readonly mode: "demo" | "api";
      enableRecognition(): Promise<void>;
      readDemoProjects(): Promise<Project[] | null>;
      writeDemoProjects(projects: Project[]): Promise<void>;
      /** Opens the native Save As dialog. It never accepts a destination path from the renderer. */
      saveMidi(
        bytes: Uint8Array,
        name: string,
      ): Promise<{ canceled: true } | { canceled: false; filePath: string }>;
    };
  }
}
