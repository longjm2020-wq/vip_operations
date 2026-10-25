import { theme, type ThemeConfig } from "antd";
import type { ThemeMode } from "../../../packages/contracts/src/appearance";

export const appThemes: Record<ThemeMode, ThemeConfig> = Object.fromEntries(
  (["dark", "light"] as const).map((mode) => {
    const dark = mode === "dark";
    return [
      mode,
      {
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: dark ? "#e6ad55" : "#b45a16",
          colorInfo: dark ? "#e6ad55" : "#b45a16",
          colorLink: dark ? "#e6ad55" : "#b45a16",
          colorInfoBg: dark ? "#30271a" : "#fff1df",
          colorInfoBorder: dark ? "#69502e" : "#e9ceac",
          colorBgLayout: dark ? "#111111" : "#f8f5f0",
          colorBgContainer: dark ? "#1b1b1b" : "#ffffff",
          colorBgElevated: dark ? "#242321" : "#ffffff",
          colorText: dark ? "#f1ede7" : "#342f29",
          colorTextSecondary: dark ? "#b7ad9f" : "#75695d",
          colorTextPlaceholder: dark ? "#8f867a" : "#9b8c7b",
          colorBorder: dark ? "#403a32" : "#e2d8cb",
          colorBorderSecondary: dark ? "#302d28" : "#ece4da",
          colorPrimaryBg: dark ? "#30271a" : "#fff1df",
          colorPrimaryBorder: dark ? "#69502e" : "#e9ceac",
          colorTextLightSolid: dark ? "#19140d" : "#ffffff",
          borderRadius: 6,
          controlHeight: 30,
          fontFamily: 'Inter, "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: {
            headerBg: dark ? "#27231d" : "#fff2e4",
            headerColor: dark ? "#d4b98d" : "#78604d",
            cellPaddingBlock: 6,
            cellPaddingBlockMD: 6,
            cellPaddingBlockSM: 5,
            cellPaddingInline: 10,
            cellFontSize: 13,
          },
          Button: {
            controlHeight: 30,
            primaryShadow: "none",
            primaryColor: dark ? "#19140d" : "#ffffff",
          },
          Card: { bodyPadding: 14, headerPadding: 14, headerHeight: 40 },
          Form: { itemMarginBottom: 12, verticalLabelPadding: "0 0 4px" },
          Menu: {
            itemHeight: 34,
            itemMarginBlock: 2,
            darkItemBg: "transparent",
            darkSubMenuItemBg: "transparent",
            darkItemColor: dark ? "#b7ad9f" : "#75695d",
            darkItemSelectedColor: dark ? "#f1ca8b" : "#a85115",
            darkItemSelectedBg: dark ? "#30271a" : "#fff1df",
            darkItemHoverColor: dark ? "#f1ede7" : "#342f29",
          },
          Tooltip: { colorTextLightSolid: "#ffffff" },
        },
      } satisfies ThemeConfig,
    ];
  }),
) as Record<ThemeMode, ThemeConfig>;
