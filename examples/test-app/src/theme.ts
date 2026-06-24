import { DarkTheme, DefaultTheme, type Theme } from 'expo-router/react-navigation';
import { useColorScheme, type ColorSchemeName } from 'react-native';

export interface AppColors {
  accent: string;
  accentSoft: string;
  card: string;
  cardStrong: string;
  danger: string;
  dangerContrast: string;
  field: string;
  line: string;
  lineStrong: string;
  mode: 'dark' | 'light';
  overlay: string;
  surface: string;
  tabBar: string;
  text: string;
  textSoft: string;
}

const brand = '#8232FF';

const darkColors: AppColors = {
  accent: brand,
  accentSoft: '#8232ff40',
  card: '#000000',
  cardStrong: '#ffffff0a',
  danger: '#b7354d',
  dangerContrast: '#ffffff',
  field: '#000000',
  line: '#ffffff14',
  lineStrong: '#ffffff29',
  mode: 'dark',
  overlay: 'rgba(0, 0, 0, 0.72)',
  surface: '#000000',
  tabBar: '#000000',
  text: '#ffffff',
  textSoft: '#ffffff99',
};

const lightColors: AppColors = {
  accent: brand,
  accentSoft: '#8232ff24',
  card: '#ffffff',
  cardStrong: '#0000000a',
  danger: '#b3263e',
  dangerContrast: '#ffffff',
  field: '#ffffff',
  line: '#00000014',
  lineStrong: '#00000029',
  mode: 'light',
  overlay: 'rgba(16, 18, 27, 0.24)',
  surface: '#ffffff',
  tabBar: '#ffffff',
  text: '#000000',
  textSoft: '#00000099',
};

export function getAppColors(scheme?: ColorSchemeName): AppColors {
  return scheme === 'light' ? lightColors : darkColors;
}

export function useAppColors(): AppColors {
  return getAppColors(useColorScheme());
}

export function getNavigationTheme(colors: AppColors): Theme {
  const baseTheme = colors.mode === 'light' ? DefaultTheme : DarkTheme;

  return {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      background: colors.surface,
      border: colors.line,
      card: colors.surface,
      notification: colors.accent,
      primary: colors.accent,
      text: colors.text,
    },
  };
}
