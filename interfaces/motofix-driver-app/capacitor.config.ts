import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.motofix.driver',   // keep this, changing it makes a different app
  appName: 'MOTOFIX',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
};

export default config;