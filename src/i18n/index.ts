import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";
import zh from "./zh.json";

const storedLanguage = localStorage.getItem("llm-wiki-webui-language");
const browserLanguage = navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: storedLanguage || browserLanguage,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

i18n.on("languageChanged", (language) => {
  localStorage.setItem("llm-wiki-webui-language", language);
});

export default i18n;
