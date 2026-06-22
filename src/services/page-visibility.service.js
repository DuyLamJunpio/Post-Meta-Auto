const { config } = require("../config");

function normalizePageName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const hiddenPageNames = new Set(
  config.facebook.hiddenPageNames
    .map(normalizePageName)
    .filter(Boolean)
);

function isHiddenPageName(name) {
  return hiddenPageNames.has(normalizePageName(name));
}

function isHiddenPage(page) {
  return Boolean(page) && isHiddenPageName(page.name);
}

function getVisiblePages(pages) {
  return Array.isArray(pages) ? pages.filter((page) => !isHiddenPage(page)) : [];
}

function getHiddenPageIds(pages) {
  return new Set(
    (Array.isArray(pages) ? pages : [])
      .filter(isHiddenPage)
      .map((page) => page.id)
      .filter(Boolean)
  );
}

function isHiddenBrandPage(brand, hiddenPageIds = new Set()) {
  if (!brand) {
    return false;
  }

  return (
    (brand.facebookPageId && hiddenPageIds.has(brand.facebookPageId)) ||
    isHiddenPageName(brand.facebookPageName)
  );
}

module.exports = {
  normalizePageName,
  isHiddenPageName,
  isHiddenPage,
  getVisiblePages,
  getHiddenPageIds,
  isHiddenBrandPage
};
