FROM golang:1.23 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /app/server .

FROM alpine:3.20
RUN apk add --no-cache wget
COPY --from=build /app/server /app/server
EXPOSE 8022
CMD ["/app/server"]
