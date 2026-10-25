import { theme, type ThemeConfig } from "antd";
import type { ThemeMode } from "../../../packages/contracts/src/appearance";

export const appThemes: Record<ThemeMode, ThemeConfig> = Object.fromEntries(
  (["dark", "light"] as const).map((mode) => {
    const dark = mode === "dark";
    const accent = dark ? "#8fa4ff" : "#435ee5";
    const accentHover = dark ? "#b4c2ff" : "#344bca";
    return [
      mode,
      {
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: accent,
          colorPrimaryHover: accentHover,
          colorPrimaryActive: dark ? "#738cff" : "#2f46bd",
          colorInfo: accent,
          colorLink: accent,
          colorLinkHover: accentHover,
          colorLinkActive: dark ? "#738cff" : "#2f46bd",
          colorInfoBg: dark ? "#222a48" : "#eff2ff",
          colorInfoBorder: dark ? "#46558d" : "#c4cef9",
          colorSuccess: dark ? "#8dc8a1" : "#347449",
          colorSuccessBg: dark ? "#1d3025" : "#eff8ef",
          colorSuccessBorder: dark ? "#365d43" : "#bad9c4",
          colorWarning: dark ? "#e6bd72" : "#906417",
          colorWarningBg: dark ? "#352b1b" : "#fff8df",
          colorWarningBorder: dark ? "#645133" : "#e5d4a8",
          colorError: dark ? "#f59b91" : "#bc3930",
          colorErrorBg: dark ? "#3c2421" : "#fff0ed",
          colorErrorBorder: dark ? "#75463e" : "#edc2ba",
          colorBgLayout: dark ? "#111111" : "#f7f8fc",
          colorBgContainer: dark ? "#1b1b1b" : "#ffffff",
          colorBgElevated: dark ? "#24262d" : "#ffffff",
          colorText: dark ? "#eef0f6" : "#272c3d",
          colorTextSecondary: dark ? "#b1b6c6" : "#626b80",
          colorTextPlaceholder: dark ? "#9199ad" : "#788297",
          colorBorder: dark ? "#3b4050" : "#dde1ec",
          colorBorderSecondary: dark ? "#2e323f" : "#e9ecf5",
          colorPrimaryBg: dark ? "#222a48" : "#eff2ff",
          colorPrimaryBgHover: dark ? "#2c3559" : "#e2e8ff",
          colorPrimaryBorder: dark ? "#46558d" : "#c4cef9",
          colorTextLightSolid: dark ? "#111828" : "#ffffff",
          borderRadius: 6,
          controlHeight: 30,
          fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: {
            headerBg: dark ? "#252936" : "#f0f3fb",
            headerColor: dark ? "#d4daf0" : "#52607c",
            cellPaddingBlock: 6,
            cellPaddingBlockMD: 6,
            cellPaddingBlockSM: 5,
            cellPaddingInline: 10,
            cellFontSize: 13,
          },
          Button: {
            controlHeight: 30,
            primaryShadow: "none",
            primaryColor: "#ffffff",
          },
          Card: { bodyPadding: 14, headerPadding: 14, headerHeight: 40 },
          Form: { itemMarginBottom: 12, verticalLabelPadding: "0 0 4px" },
          Menu: {
            itemHeight: 34,
            itemMarginBlock: 2,
            darkItemBg: "transparent",
            darkSubMenuItemBg: "transparent",
            itemSelectedColor: accent,
            itemSelectedBg: dark ? "#222a48" : "#eff2ff",
            darkItemColor: dark ? "#b1b6c6" : "#626b80",
            darkItemSelectedColor: accent,
            darkItemSelectedBg: dark ? "#222a48" : "#eff2ff",
            darkItemHoverColor: dark ? "#eef0f6" : "#272c3d",
          },
          Tooltip: { colorTextLightSolid: "#ffffff" },
        },
      } satisfies ThemeConfig,
    ];
  }),
) as Record<ThemeMode, ThemeConfig>;
