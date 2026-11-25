import { dotnet } from "./_framework/dotnet.js";

let analyzeFnPromise = null;

async function getAnalyzer() {
  if (!analyzeFnPromise) {
    analyzeFnPromise = (async () => {
      const { getAssemblyExports, getConfig } = await dotnet.create();
      const config = getConfig();
      const exports = await getAssemblyExports(config.mainAssemblyName);
      return exports.ReplayApi.AnalyzeReplay;
    })();
  }
  return analyzeFnPromise;
}

self.onmessage = async (event) => {
  const { id, fileName, buffer } = event.data;
  try {
    const analyzeReplay = await getAnalyzer();
    const rawJson = analyzeReplay(new Uint8Array(buffer), fileName);
    const result = JSON.parse(rawJson);
    self.postMessage({ id, result });
  } catch (error) {
    self.postMessage({
      id,
      result: {
        ok: false,
        fileName,
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
};
