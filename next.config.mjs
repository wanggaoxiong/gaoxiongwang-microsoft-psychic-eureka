/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { allowedOrigins: ['*'] },
    serverComponentsExternalPackages: ['whatsapp-web.js', 'puppeteer', 'qrcode', 'playwright']
  },
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // whatsapp-web.js 间接依赖 unzipper -> @aws-sdk/client-s3（仅 RemoteAuth 才需要，我们没用）
      // 把它们标记为可选，避免 webpack 解析失败
      config.externals = config.externals || [];
      if (Array.isArray(config.externals)) {
        config.externals.push({
          '@aws-sdk/client-s3': 'commonjs @aws-sdk/client-s3'
        });
      }
    }
    return config;
  }
};
export default nextConfig;
