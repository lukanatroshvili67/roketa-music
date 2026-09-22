// PM2 process file: `pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: 'roketa-music',
      script: 'src/index.js',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      max_restarts: 50,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '600M',
      kill_timeout: 12000,
    },
  ],
};
