# 发布 Hub P2 清理

将本机已验收的 P2 提交部署到远程 Hub，移除 Knbase 导航及工作区筛选。发布只涉及 Hub 容器。本机 Worker 和 Knbase LaunchAgent 已完成交接。

当前机器缺少 Kubernetes 当前上下文和 Docker daemon。以下步骤在已授权的构建机和发布终端执行。

1. 从包含 P2 提交的已审核分支创建干净 checkout。记录 `git rev-parse HEAD`，执行 `npm ci`、`npm run test:dom`、`npm run test:runtime` 和 `npm run test:workspaces`。确认发布树未包含本机未提交改动。
2. 从生产部署读取并记录当前容器镜像及实际 imageID digest、命名空间、deployment、容器名、集群上下文和目标 CPU 架构。核对部署的卷、环境和入口，按现有运维流程取得数据库一致性备份。固定旧镜像摘要作为回退目标。
3. 在符合目标架构且已登录批准 registry 的构建环境执行下列命令。使用唯一提交标签，记录推送后的镜像摘要。

   ```sh
   revision=$(git rev-parse HEAD)
   image="${HUB_REGISTRY_REPO:?}:p2-$revision"
   npm run image:build -- "$image"
   docker push "$image"
   docker buildx imagetools inspect "$image"
   ```

4. 在 Sealos 的现有部署配置中替换 Hub 容器镜像为上一步的摘要引用。若使用 Kubernetes CLI，先填入核对过的变量。等 rollout 成功后，检查已运行 Pod 的 imageID。

   ```sh
   kubectl --context "${HUB_CONTEXT:?}" -n "${HUB_NAMESPACE:?}" set image \
     "deployment/${HUB_DEPLOYMENT:?}" "${HUB_CONTAINER:?}=${HUB_IMAGE_DIGEST:?}"
   kubectl --context "$HUB_CONTEXT" -n "$HUB_NAMESPACE" rollout status \
     "deployment/$HUB_DEPLOYMENT" --timeout=5m
   ```

5. 在生产浏览器刷新 Hub，确认 Knbase 导航消失、其他导航可用。检查 `/api/health` 的 Worker 连接，使用现有认证会话确认 runtime 列表无 `myknbase` 且其他 runtime 正常显示。记录发布 revision、镜像摘要及验收结果。
6. 若远程验收失败，在步骤 4 将镜像设为已记录且确认与现有数据库兼容的旧摘要，再验证 rollout 和应用健康。保留本机 Knbase 和 Worker 的 P3 交接状态。
