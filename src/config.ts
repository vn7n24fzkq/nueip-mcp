import { readFileSync } from "node:fs";

export interface LocationPreset {
  name: string;
  lat: number;
  lng: number;
}

export interface Config {
  companyCode: string;
  employeeId: string;
  password: string;
  presets: LocationPreset[];
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  let presets: LocationPreset[] = [];
  const presetsPath = process.env.NUEIP_PRESETS_PATH;
  if (presetsPath) {
    try {
      const raw = readFileSync(presetsPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.presets)) presets = parsed.presets;
    } catch (e) {
      // file is optional; ignore read errors
    }
  }

  return {
    companyCode: required("NUEIP_COMPANY_CODE"),
    employeeId: required("NUEIP_EMPLOYEE_ID"),
    password: required("NUEIP_PASSWORD"),
    presets,
  };
}
