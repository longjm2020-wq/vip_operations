import { theme, type ThemeConfig } from "antd";
import type { ThemeMode } from "../../../packages/contracts/src/appearance";

export const appThemes: Record<ThemeMode, ThemeConfig> = Object.fromEntries(
  (["dark", "light"] as const).map((mode) => {
    const dark = mode === "dark";
    const accent = dark ? "#e8bf3c" : "#846200";
    const accentHover = dark ? "#f4d76b" : "#694d00";
    return [
      mode,
      {
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: accent,
          colorPrimaryHover: accentHover,
          colorPrimaryActive: dark ? "#d6ad2e" : "#5c4400",
          colorInfo: accent,
          colorLink: accent,
          colorLinkHover: accentHover,
          colorLinkActive: dark ? "#d6ad2e" : "#5c4400",
          colorInfoBg: dark ? "#302a18" : "#faf3d8",
          colorInfoBorder: dark ? "#6d5a26" : "#dccc91",
          colorBgLayout: dark ? "#111111" : "#f8f5f0",
          colorBgContainer: dark ? "#1b1b1b" : "#ffffff",
          colorBgElevated: dark ? "#242321" : "#ffffff",
          colorText: dark ? "#f1ede7" : "#342f29",
          colorTextSecondary: dark ? "#b9b7b0" : "#6b6960",
          colorTextPlaceholder: dark ? "#8f8b81" : "#918b7d",
          colorBorder: dark ? "#3e3b32" : "#dedacf",
          colorBorderSecondary: dark ? "#302e27" : "#eae6dc",
          colorPrimaryBg: dark ? "#302a18" : "#faf3d8",
          colorPrimaryBgHover: dark ? "#3d341c" : "#f4e9bc",
          colorPrimaryBorder: dark ? "#6d5a26" : "#dccc91",
          colorTextLightSolid: dark ? "#19140d" : "#ffffff",
          borderRadius: 6,
          controlHeight: 30,
          fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: {
            headerBg: dark ? "#27261f" : "#f6f4eb",
            headerColor: dark ? "#d8d5c8" : "#625d4d",
            cellPaddingBlock: 6,
            cellPaddingBlockMD: 6,
            cellPaddingBlockSM: 5,
            cellPaddingInline: 10,
            cellFontSize: 13,
          },
          Button: {
            controlHeight: 30,
            primaryShadow: "none",
            primaryColor: "#211c0e",
          },
          Card: { bodyPadding: 14, headerPadding: 14, headerHeight: 40 },
          Form: { itemMarginBottom: 12, verticalLabelPadding: "0 0 4px" },
          Menu: {
            itemHeight: 34,
            itemMarginBlock: 2,
            darkItemBg: "transparent",
            darkSubMenuItemBg: "transparent",
            itemSelectedColor: accent,
            itemSelectedBg: dark ? "#302a18" : "#faf3d8",
            darkItemColor: dark ? "#b9b7b0" : "#6b6960",
            darkItemSelectedColor: accent,
            darkItemSelectedBg: dark ? "#302a18" : "#faf3d8",
            darkItemHoverColor: dark ? "#f1ede7" : "#342f29",
          },
          Tooltip: { colorTextLightSolid: "#ffffff" },
        },
      } satisfies ThemeConfig,
    ];
  }),
) as Record<ThemeMode, ThemeConfig>;
