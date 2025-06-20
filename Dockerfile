# --- Stage 1: Build ---
# 使用官方的 Go 镜像作为构建环境
FROM golang:1.22-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制 Go 模块文件并下载依赖
# 将 server 目录下的 go.mod 和 go.sum 复制到当前工作目录
COPY server/go.mod server/go.sum ./
RUN go env -w GO111MODULE=on && \
    go env -w GOPROXY=https://goproxy.cn,direct && \
    go mod download

# 复制服务器源代码
# 将 server 目录下的所有文件复制到当前工作目录
COPY server/. .

# 编译 Go 应用，-ldflags="-s -w" 用于减小二进制文件大小
# CGO_ENABLED=0 是为了静态编译，确保在 alpine 这种极简镜像中也能运行
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /webrtc_server .

# --- Stage 2: Final Image ---
# 使用一个非常小的基础镜像，以保证最终镜像的体积小
FROM alpine:latest

# 设置工作目录
WORKDIR /app

# 从构建阶段 (builder) 复制编译好的二进制文件到当前工作目录
COPY --from=builder /webrtc_server .

# 复制前端静态文件
# 注意这里的路径，Dockerfile 在 GO/ 目录下，所以 client 和 controller 是相对路径
COPY client/ ./client/
COPY controller/ ./controller/

# 暴露应用运行的端口
EXPOSE 8080

# 设置容器启动时运行的命令
CMD ["./webrtc_server"]