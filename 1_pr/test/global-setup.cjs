const { execSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function globalSetup() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL must be set for e2e (see .env.test.example in project root).',
    );
  }

  execSync('pnpm exec prisma migrate deploy', {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
};
