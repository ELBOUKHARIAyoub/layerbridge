// Single source for the LayerBridge brand: colours and the logo mark.
// Used by the launcher's status page, the panel build (scripts/sync-ui.mjs) and the PNG generator.
export const BRAND = {
  violet: "#5B3DF5", // primary
  violetDark: "#6A4DFF", // primary on dark backgrounds
  coral: "#FF5E7E", // accent
  ink: "#1B1535", // text on light
  paper: "#FBFAFF", // light background
  night: "#14121F", // dark background
};

// A stack of three layers on a gradient badge. The top layer is solid and the ones below fade out.
// The name carries the "bridge".
export const markBody = (id) => `
  <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${BRAND.violet}"/><stop offset="1" stop-color="${BRAND.coral}"/></linearGradient></defs>
  <rect width="64" height="64" rx="15" fill="url(#${id})"/>
  <path d="M32 11L54 23L32 35L10 23Z" fill="#fff" stroke="#fff" stroke-width="3" stroke-linejoin="round"/>
  <path d="M11 32L32 43.5L53 32" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".72"/>
  <path d="M11 41L32 52.5L53 41" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" opacity=".42"/>`;

export const markSvg = (id = "lbg", size = 64) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">${markBody(id)}\n</svg>`;
