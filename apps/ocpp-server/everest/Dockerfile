ARG EVEREST_IMAGE_TAG="2025.6.1-dt-esdp"
ARG EVEREST_IMAGE_REPOSITORY="ghcr.io/everest/everest-demo/manager"
FROM ${EVEREST_IMAGE_REPOSITORY}:${EVEREST_IMAGE_TAG}

WORKDIR /workspace

RUN npm config set registry https://mirror2.chabokan.net/npm/
RUN npm i -g http-server
EXPOSE 8888

COPY ./start.sh /tmp/start.sh
RUN chmod +x /tmp/start.sh
ENTRYPOINT ["/tmp/start.sh"]
