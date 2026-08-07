FROM postgres:16-alpine

RUN apk add --no-cache openssl

COPY entrypoint.sh /usr/local/bin/postgres-tls-entrypoint
RUN chmod 0755 /usr/local/bin/postgres-tls-entrypoint

ENTRYPOINT ["postgres-tls-entrypoint"]
CMD ["postgres"]
