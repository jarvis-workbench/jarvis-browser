import { computed, ref, type ComputedRef } from 'vue';
import type { Site, SiteExtension } from '../../shared/types';

type BrowserExtensionsOptions = {
  selectedSite: ComputedRef<Site | null>;
  patchSite: (siteId: string, patch: Partial<Site>) => void;
  setStatusMessage: (message: string) => void;
};

export function useBrowserExtensions(options: BrowserExtensionsOptions) {
  const globalExtensions = ref<SiteExtension[]>([]);
  const siteExtensions = ref<SiteExtension[]>([]);
  const popupExtensions = computed(() =>
    [...globalExtensions.value, ...siteExtensions.value].filter((extension) =>
      extension.enabled && Boolean(extension.action?.defaultPopup),
    ),
  );

  async function loadExtensions(siteId: string) {
    const [nextGlobalExtensions, nextSiteExtensions] = await Promise.all([
      window.appApi.extensions.listGlobal(),
      window.appApi.extensions.listSite(siteId),
    ]);
    globalExtensions.value = nextGlobalExtensions;
    siteExtensions.value = nextSiteExtensions;
  }

  async function installGlobalExtension() {
    const extension = await window.appApi.extensions.installGlobal();
    if (!extension) {
      return;
    }

    globalExtensions.value = upsertExtension(globalExtensions.value, extension);
    options.setStatusMessage(`${extension.name} 已安装为全局插件`);
  }

  async function installSiteExtension() {
    const selectedSite = options.selectedSite.value;
    if (!selectedSite) {
      return;
    }

    const extension = await window.appApi.extensions.installSite(selectedSite.id);
    if (!extension) {
      return;
    }

    siteExtensions.value = upsertExtension(siteExtensions.value, extension);
    options.patchSite(selectedSite.id, { extensions: upsertExtension(selectedSite.extensions, extension) });
    options.setStatusMessage(`${extension.name} 已安装到当前站点`);
  }

  async function toggleGlobalExtension(extension: SiteExtension) {
    const updated = extension.enabled
      ? await window.appApi.extensions.disableGlobal(extension.id)
      : await window.appApi.extensions.enableGlobal(extension.id);

    globalExtensions.value = upsertExtension(globalExtensions.value, updated);
  }

  async function toggleSiteExtension(extension: SiteExtension) {
    const selectedSite = options.selectedSite.value;
    if (!selectedSite) {
      return;
    }

    const updated = extension.enabled
      ? await window.appApi.extensions.disableSite(selectedSite.id, extension.id)
      : await window.appApi.extensions.enableSite(selectedSite.id, extension.id);

    siteExtensions.value = upsertExtension(siteExtensions.value, updated);
    options.patchSite(selectedSite.id, { extensions: upsertExtension(selectedSite.extensions, updated) });
  }

  async function uninstallGlobalExtension(extension: SiteExtension) {
    await window.appApi.extensions.uninstallGlobal(extension.id);
    globalExtensions.value = globalExtensions.value.filter((item) => item.id !== extension.id);
  }

  async function uninstallSiteExtension(extension: SiteExtension) {
    const selectedSite = options.selectedSite.value;
    if (!selectedSite) {
      return;
    }

    await window.appApi.extensions.uninstallSite(selectedSite.id, extension.id);
    siteExtensions.value = siteExtensions.value.filter((item) => item.id !== extension.id);
    options.patchSite(selectedSite.id, {
      extensions: selectedSite.extensions.filter((item) => item.id !== extension.id),
    });
  }

  function syncSiteExtensions(siteId: string, nextExtensions: SiteExtension[]) {
    const selectedSite = options.selectedSite.value;
    if (siteId === selectedSite?.id) {
      siteExtensions.value = nextExtensions;
    }
    options.patchSite(siteId, { extensions: nextExtensions });
  }

  function clearSiteExtensions() {
    siteExtensions.value = [];
  }

  return {
    globalExtensions,
    siteExtensions,
    popupExtensions,
    loadExtensions,
    installGlobalExtension,
    installSiteExtension,
    toggleGlobalExtension,
    toggleSiteExtension,
    uninstallGlobalExtension,
    uninstallSiteExtension,
    syncSiteExtensions,
    clearSiteExtensions,
  };
}

function upsertExtension(items: SiteExtension[], extension: SiteExtension) {
  const exists = items.some((item) => item.id === extension.id);
  return exists ? items.map((item) => (item.id === extension.id ? extension : item)) : [...items, extension];
}
