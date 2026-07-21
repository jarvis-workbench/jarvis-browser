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
  const pinnedExtensionIds = ref<string[]>([]);
  const availablePopupExtensions = computed(() => {
    const siteScoped = siteExtensions.value.length
      ? siteExtensions.value
      : (options.selectedSite.value?.extensions ?? []);
    const byId = new Map<string, SiteExtension>();
    for (const extension of [...globalExtensions.value, ...siteScoped]) {
      if (!extension.enabled || !extension.action?.defaultPopup) {
        continue;
      }
      byId.set(extension.id, extension);
    }
    return [...byId.values()];
  });
  const popupExtensions = availablePopupExtensions;
  const pinnedExtensions = computed(() => {
    const byId = new Map(availablePopupExtensions.value.map((extension) => [extension.id, extension]));
    return pinnedExtensionIds.value
      .map((id) => byId.get(id))
      .filter((extension): extension is SiteExtension => Boolean(extension));
  });

  async function loadExtensions(siteId?: string) {
    const tasks: Promise<unknown>[] = [
      window.appApi.extensions.listGlobal(),
      window.appApi.extensions.listPinned(),
    ];
    if (siteId) {
      tasks.push(window.appApi.extensions.listSite(siteId));
    }

    const [nextGlobalExtensions, nextPinnedExtensionIds, nextSiteExtensions] = await Promise.all(tasks);
    globalExtensions.value = nextGlobalExtensions as SiteExtension[];
    pinnedExtensionIds.value = nextPinnedExtensionIds as string[];
    if (siteId) {
      siteExtensions.value = nextSiteExtensions as SiteExtension[];
    }
  }

  async function loadPinnedExtensions() {
    pinnedExtensionIds.value = await window.appApi.extensions.listPinned();
  }

  async function togglePinnedExtension(extensionId: string) {
    pinnedExtensionIds.value = await window.appApi.extensions.togglePinned(extensionId);
    return pinnedExtensionIds.value;
  }

  function setPinnedExtensionIds(extensionIds: string[]) {
    pinnedExtensionIds.value = [...extensionIds];
  }

  async function installGlobalExtension() {
    const extension = await window.appApi.extensions.installGlobal();
    if (!extension) {
      return;
    }

    globalExtensions.value = upsertExtension(globalExtensions.value, extension);
    options.setStatusMessage(`${extension.name} 已安装为全局扩展程序`);
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
    pinnedExtensionIds,
    popupExtensions,
    pinnedExtensions,
    loadExtensions,
    loadPinnedExtensions,
    togglePinnedExtension,
    setPinnedExtensionIds,
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
