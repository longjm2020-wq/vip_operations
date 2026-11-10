import { theme, type ThemeConfig } from "antd";
import type { ThemeMode } from "../../../packages/contracts/src/appearance";

export const appThemes: Record<ThemeMode, ThemeConfig> = Object.fromEntries(
  (["dark", "light"] as const).map((mode) => {
    const dark = mode === "dark";
    const accent = dark ? "#8fa9ff" : "#435ee5";
    const accentHover = dark ? "#b8c8ff" : "#344bca";
    return [
      mode,
      {
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: accent,
          colorPrimaryHover: accentHover,
          colorPrimaryActive: dark ? "#7c9aff" : "#2f46bd",
          colorInfo: accent,
          colorLink: accent,
          colorLinkHover: accentHover,
          colorLinkActive: dark ? "#7c9aff" : "#2f46bd",
          colorInfoBg: dark ? "#24355f" : "#eff2ff",
          colorInfoBorder: dark ? "#6079c5" : "#c4cef9",
          colorSuccess: dark ? "#4ee2a2" : "#347449",
          colorSuccessBg: dark ? "#123b31" : "#eff8ef",
          colorSuccessBorder: dark ? "#267d61" : "#bad9c4",
          colorWarning: dark ? "#ffce64" : "#906417",
          colorWarningBg: dark ? "#403019" : "#fff8df",
          colorWarningBorder: dark ? "#8b6830" : "#e5d4a8",
          colorError: dark ? "#ff8c9c" : "#bc3930",
          colorErrorBg: dark ? "#481f31" : "#fff0ed",
          colorErrorBorder: dark ? "#a24863" : "#edc2ba",
          colorBgLayout: dark ? "#0b0c0f" : "#f7f8fc",
          colorBgContainer: dark ? "#17181d" : "#ffffff",
          colorBgElevated: dark ? "#292c35" : "#ffffff",
          colorText: dark ? "#f4f7ff" : "#272c3d",
          colorTextSecondary: dark ? "#becde6" : "#626b80",
          colorTextPlaceholder: dark ? "#9caccc" : "#788297",
          colorBorder: dark ? "#4b6189" : "#dde1ec",
          colorBorderSecondary: dark ? "#334564" : "#e9ecf5",
          colorPrimaryBg: dark ? "#24355f" : "#eff2ff",
          colorPrimaryBgHover: dark ? "#293d6b" : "#e2e8ff",
          colorPrimaryBorder: dark ? "#6079c5" : "#c4cef9",
          colorTextLightSolid: dark ? "#0c1528" : "#ffffff",
          borderRadius: 6,
          controlHeight: 30,
          fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: {
            headerBg: dark ? "#20304c" : "#f0f3fb",
            headerColor: dark ? "#e1eaff" : "#52607c",
            rowHoverBg: dark ? "#1d2d4c" : "#f5f6fb",
            rowSelectedBg: dark ? "#24355f" : "#eff2ff",
            rowSelectedHoverBg: dark ? "#293d6b" : "#e2e8ff",
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
            itemSelectedBg: dark ? "#24355f" : "#eff2ff",
            darkItemColor: dark ? "#becde6" : "#626b80",
            darkItemSelectedColor: accent,
            darkItemSelectedBg: dark ? "#24355f" : "#eff2ff",
            darkItemHoverColor: dark ? "#f4f7ff" : "#272c3d",
          },
          Tooltip: { colorTextLightSolid: "#ffffff" },
        },
      } satisfies ThemeConfig,
    ];
  }),
) as Record<ThemeMode, ThemeConfig>;
