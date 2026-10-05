FROM nginx:alpine
ARG GIT_COMMIT=unknown
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html
COPY src /usr/share/nginx/html/src
RUN printf '%s\n' \
      '// Generated at image build — do not edit.' \
      "export const BUILD_COMMIT = \"${GIT_COMMIT}\";" \
      > /usr/share/nginx/html/src/buildInfo.js
EXPOSE 80
