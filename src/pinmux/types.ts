export interface PinmuxSignal {
  direction: "input" | "output" | "bidirectional" | "unknown";
  defaultValue: number | null;
  description?: string;
}

export interface PinmuxFunction {
  mux: number;
  signal: string;
}

export interface PinmuxPin {
  id: string;
  powerDomain: string;
  pad: string;
  default: {
    mode: "input" | "output" | "alternate";
    pull: "none" | "up" | "down";
    driveStrength_mA: number | string;
    mux?: number;
    outputLevel?: 0 | 1;
    schmitt?: boolean;
    slew?: boolean;
  };
  functions: PinmuxFunction[];
}

export interface PinmuxPeripheralGroupAssignment {
  signal: string;
  pin: string;
  mux: number;
}

export interface PinmuxPeripheralGroup {
  id: string;
  peripheral: string;
  label: string;
  assignments: PinmuxPeripheralGroupAssignment[];
}

export interface PinmuxDefinition {
  format: "impx";
  version: 1;
  chip: { id: string; name: string };
  package: { id: string; name: string; pinCount: number };
  source?: { file: string; revision: string; date: string; sheets: string[] };
  signals: Record<string, PinmuxSignal>;
  pins: PinmuxPin[];
  peripheralGroups: PinmuxPeripheralGroup[];
}
