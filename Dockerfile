# The stop-rules team server: a locked down Jev proxy on port 8080.
# This one image is the deploy path for Cloud Run, Azure Container Apps, Fly.io, Render,
# Railway, DigitalOcean App Platform and Heroku (with heroku.yml).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
# The image only needs the compiled server, not the vendored bundle or the AWS template, so
# it runs the TypeScript compile on its own rather than the whole npm run build.
RUN npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Every platform that sets PORT wins over this default.
ENV PORT=8080
# package.json is needed at runtime for "type": "module", not for dependencies: there are none.
COPY package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 8080
USER node
CMD ["node", "dist/server/start.js"]
