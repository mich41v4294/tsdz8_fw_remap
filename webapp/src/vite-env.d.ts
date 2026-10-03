/// <reference types="vite/client" />

interface USBEndpoint {
  readonly endpointNumber: number;
  readonly direction: "in" | "out";
  readonly type: "bulk" | "interrupt" | "isochronous" | "control";
}

interface USBAlternateInterface {
  readonly endpoints: USBEndpoint[];
}

interface USBInterface {
  readonly interfaceNumber: number;
  readonly alternates: USBAlternateInterface[];
}

interface USBConfiguration {
  readonly interfaces: USBInterface[];
}

interface USBInTransferResult {
  readonly status: string;
  readonly data?: DataView;
}

interface USBOutTransferResult {
  readonly status: string;
  readonly bytesWritten?: number;
}

interface USBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly configuration: USBConfiguration | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
}

interface USB {
  requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<USBDevice>;
}

interface Navigator {
  readonly usb?: USB;
}
