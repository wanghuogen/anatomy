/** Script group decides which font pair loads. Keeping this separate from the
 *  locale list means adding a Latin-script locale costs no extra font weight. */
export type ScriptGroup = "latin" | "cyrillic" | "devanagari" | "arabic" | "sc" | "jp" | "kr";

export type LocaleConfig = {
  code: string;
  /** Endonym — what speakers call the language, shown in the switcher. */
  nativeName: string;
  englishName: string;
  country: string;
  dir: "ltr" | "rtl";
  script: ScriptGroup;
  /** BCP-47 tag for Intl formatting and og:locale. */
  intl: string;
};

export const locales: LocaleConfig[] = [
  { code: "zh", nativeName: "中文",      englishName: "Chinese",    country: "China",         dir: "ltr", script: "sc",         intl: "zh_CN" },
  { code: "en", nativeName: "English",  englishName: "English",    country: "United States", dir: "ltr", script: "latin",      intl: "en_US" },
];

export const defaultLocale = "zh";
export const localeCodes = locales.map((locale) => locale.code);

export function getLocale(code: string): LocaleConfig {
  return locales.find((locale) => locale.code === code) ?? locales[0];
}

export function isLocale(code: string): boolean {
  return localeCodes.includes(code);
}
