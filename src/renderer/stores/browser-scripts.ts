import { ref, type ComputedRef } from 'vue';
import type { JarvisScript, Site } from '../../shared/types';

type BrowserScriptsOptions = {
  selectedSite: ComputedRef<Site | null>;
  patchSite: (siteId: string, patch: Partial<Site>) => void;
  setStatusMessage: (message: string) => void;
};

export function useBrowserScripts(options: BrowserScriptsOptions) {
  const globalScripts = ref<JarvisScript[]>([]);
  const siteScripts = ref<JarvisScript[]>([]);

  async function loadScripts(siteId: string) {
    const [nextGlobalScripts, nextSiteScripts] = await Promise.all([
      window.appApi.jarvisScripts.listGlobal(),
      window.appApi.jarvisScripts.listSite(siteId),
    ]);
    globalScripts.value = nextGlobalScripts;
    siteScripts.value = nextSiteScripts;
  }

  async function installGlobalScript() {
    const script = await window.appApi.jarvisScripts.installGlobal();
    if (!script) {
      return;
    }

    globalScripts.value = upsertScript(globalScripts.value, script);
    options.setStatusMessage(`${script.name} 已安装为全局脚本`);
  }

  async function installSiteScript() {
    const selectedSite = options.selectedSite.value;
    if (!selectedSite) {
      return;
    }

    const script = await window.appApi.jarvisScripts.installSite(selectedSite.id);
    if (!script) {
      return;
    }

    siteScripts.value = upsertScript(siteScripts.value, script);
    options.patchSite(selectedSite.id, { jarvisScripts: upsertScript(selectedSite.jarvisScripts, script) });
    options.setStatusMessage(`${script.name} 已安装到当前站点`);
  }

  async function toggleGlobalScript(script: JarvisScript) {
    const updated = script.runtimeState.enabled
      ? await window.appApi.jarvisScripts.disableGlobal(script.id)
      : await window.appApi.jarvisScripts.enableGlobal(script.id);

    globalScripts.value = upsertScript(globalScripts.value, updated);
  }

  async function toggleSiteScript(script: JarvisScript) {
    const selectedSite = options.selectedSite.value;
    if (!selectedSite) {
      return;
    }

    const updated = script.runtimeState.enabled
      ? await window.appApi.jarvisScripts.disableSite(selectedSite.id, script.id)
      : await window.appApi.jarvisScripts.enableSite(selectedSite.id, script.id);

    siteScripts.value = upsertScript(siteScripts.value, updated);
    options.patchSite(selectedSite.id, { jarvisScripts: upsertScript(selectedSite.jarvisScripts, updated) });
  }

  async function uninstallGlobalScript(script: JarvisScript) {
    await window.appApi.jarvisScripts.uninstallGlobal(script.id);
    globalScripts.value = globalScripts.value.filter((item) => item.id !== script.id);
  }

  async function uninstallSiteScript(script: JarvisScript) {
    const selectedSite = options.selectedSite.value;
    if (!selectedSite) {
      return;
    }

    await window.appApi.jarvisScripts.uninstallSite(selectedSite.id, script.id);
    siteScripts.value = siteScripts.value.filter((item) => item.id !== script.id);
    options.patchSite(selectedSite.id, {
      jarvisScripts: selectedSite.jarvisScripts.filter((item) => item.id !== script.id),
    });
  }

  function syncScripts(siteId: string | undefined, scripts: JarvisScript[]) {
    if (!siteId) {
      globalScripts.value = scripts;
      return;
    }

    const selectedSite = options.selectedSite.value;
    if (selectedSite && selectedSite.id === siteId) {
      siteScripts.value = scripts;
    }
    options.patchSite(siteId, { jarvisScripts: scripts });
  }

  function clearSiteScripts() {
    siteScripts.value = [];
  }

  return {
    globalScripts,
    siteScripts,
    loadScripts,
    installGlobalScript,
    installSiteScript,
    toggleGlobalScript,
    toggleSiteScript,
    uninstallGlobalScript,
    uninstallSiteScript,
    syncScripts,
    clearSiteScripts,
  };
}

function upsertScript(items: JarvisScript[], script: JarvisScript) {
  const exists = items.some((item) => item.id === script.id);
  return exists ? items.map((item) => (item.id === script.id ? script : item)) : [...items, script];
}
