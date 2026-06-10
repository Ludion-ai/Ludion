import type { AdapterInfo, DeviceInfo } from "./schema";

/**
 * Device capability probe. Every API that is not available on iOS Safari is
 * feature-gated; absence is recorded as null, never a crash (spec Section 3).
 */

// GPUSupportedLimits is not JSON-serializable and not enumerable; read a fixed
// key list (implementation note from spec review).
const LIMIT_KEYS = [
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  "maxBufferSize",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
] as const;

async function probeAdapter(): Promise<AdapterInfo | null> {
  if (!("gpu" in navigator) || !navigator.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const limitsRaw: Record<string, number> = {};
    for (const key of LIMIT_KEYS) {
      const value = (adapter.limits as unknown as Record<string, unknown>)[key];
      if (typeof value === "number") limitsRaw[key] = value;
    }
    return {
      vendor: adapter.info?.vendor ?? "",
      architecture: adapter.info?.architecture ?? "",
      f16: adapter.features.has("shader-f16"),
      maxBufferSize: adapter.limits.maxBufferSize,
      limitsRaw,
    };
  } catch {
    return null;
  }
}

export async function probeDevice(operatorLabel: string): Promise<DeviceInfo> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const adapter = await probeAdapter();
  return {
    ua: navigator.userAgent,
    webgpu: adapter !== null,
    adapter,
    hw_concurrency: navigator.hardwareConcurrency ?? 0,
    device_memory_gb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    screen: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
    operator_label: operatorLabel,
  };
}
