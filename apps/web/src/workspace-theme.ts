import { theme, type ThemeConfig } from "antd";
import type { ThemeMode } from "../../../packages/contracts/src/appearance";

export const appThemes: Record<ThemeMode, ThemeConfig> = Object.fromEntries(
  (["dark", "light"] as const).map((mode) => {
    const dark = mode === "dark";
    const accent = dark ? "#8fa9ff" : "#284bd6";
    const accentHover = dark ? "#b8c8ff" : "#203db8";
    return [
      mode,
      {
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: accent,
          colorPrimaryHover: accentHover,
          colorPrimaryActive: dark ? "#7c9aff" : "#18319e",
          colorInfo: accent,
          colorLink: accent,
          colorLinkHover: accentHover,
          colorLinkActive: dark ? "#7c9aff" : "#18319e",
          colorInfoBg: dark ? "#24355f" : "#e6edff",
          colorInfoBorder: dark ? "#6079c5" : "#9aafea",
          colorSuccess: dark ? "#4ee2a2" : "#087b4f",
          colorSuccessBg: dark ? "#123b31" : "#e8faf1",
          colorSuccessBorder: dark ? "#267d61" : "#87d8b2",
          colorWarning: dark ? "#ffce64" : "#8a5700",
          colorWarningBg: dark ? "#403019" : "#fff4d1",
          colorWarningBorder: dark ? "#8b6830" : "#e8c15e",
          colorError: dark ? "#ff8c9c" : "#c02b43",
          colorErrorBg: dark ? "#481f31" : "#ffebef",
          colorErrorBorder: dark ? "#a24863" : "#ee9aab",
          colorBgLayout: dark ? "#0b0c0f" : "#f5f5f5",
          colorBgContainer: dark ? "#17181d" : "#ffffff",
          colorBgElevated: dark ? "#292c35" : "#ffffff",
          colorText: dark ? "#f4f7ff" : "#262626",
          colorTextSecondary: dark ? "#becde6" : "#595959",
          colorTextPlaceholder: dark ? "#9caccc" : "#737373",
          colorBorder: dark ? "#4b6189" : "#d9d9d9",
          colorBorderSecondary: dark ? "#334564" : "#d9d9d9",
          colorPrimaryBg: dark ? "#24355f" : "#e6edff",
          colorPrimaryBgHover: dark ? "#293d6b" : "#d7e2ff",
          colorPrimaryBorder: dark ? "#6079c5" : "#9aafea",
          colorTextLightSolid: dark ? "#0c1528" : "#ffffff",
          borderRadius: 6,
          controlHeight: 30,
          fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: {
            headerBg: dark ? "#20304c" : "#f0f0f0",
            headerColor: dark ? "#e1eaff" : "#434343",
            rowHoverBg: dark ? "#1d2d4c" : "#fafafa",
            rowSelectedBg: dark ? "#24355f" : "#e6edff",
            rowSelectedHoverBg: dark ? "#293d6b" : "#d7e2ff",
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
            itemSelectedBg: dark ? "#24355f" : "#e6edff",
            darkItemColor: dark ? "#becde6" : "#595959",
            darkItemSelectedColor: accent,
            darkItemSelectedBg: dark ? "#24355f" : "#e6edff",
            darkItemHoverColor: dark ? "#f4f7ff" : "#262626",
          },
          Tooltip: { colorTextLightSolid: "#ffffff" },
        },
      } satisfies ThemeConfig,
    ];
  }),
) as Record<ThemeMode, ThemeConfig>;
