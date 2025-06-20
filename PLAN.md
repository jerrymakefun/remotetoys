# Web 远程性玩具控制项目计划 (v2 - 精度模式)

## 1. 项目目标

创建一个 Web 应用，允许用户通过互联网远程控制连接到 Intiface Core 的性玩具（活塞行程类）。提供两种控制方式：**网页滑块 (精度模式)** 和手机摇动 (待实现)，并允许用户自定义控制的强度限制和采样间隔，目标是实现流畅、可预测的控制体验。

## 2. 核心功能

*   **行程控制**: 控制玩具的线性运动位置（行程 0-100%）。
*   **滑块控制 (精度模式)**:
   *   拖动时，在内部进行**高频采样** (e.g., `requestAnimationFrame`) 读取滑块位置和时间戳，存入缓冲区。
   *   以用户可配置的**指令发送间隔** (`sampleIntervalMs`) 定期触发指令构造。
   *   指令构造时，基于采样缓冲区计算**平滑速度**和获取**最新位置**。
   *   将映射到用户设定范围后的**位置**、计算出的**速度**和**指令发送间隔**发送给服务器。
*   **手机摇动控制**: (待实现)
   *   手机的 **倾斜角度** 映射为玩具的 **行程**。
    *   手机的 **摇动速度** 映射为玩具的运动速度。
*   **用户可调参数**:
    *   操控端提供 UI 允许用户设置：
        *   **行程范围** (%): 使用自定义**双柄范围滑块**设置最小和最大行程值 (默认 1%-99%)。
        *   **最大速度** (%)
        *   **指令发送间隔** (ms): 控制向服务器发送指令的频率。
    *   主滑块位置会映射到用户设定的行程范围内。
    *   发送指令前应用最大速度限制。
*   **模式切换**: 操控端提供切换“滑块 (精度)”模式和“体感”模式的选项。
*   **停止机制**: 用户停止拖动滑块时，停止发送新指令，让玩具执行完最后一条收到的指令后自然停止。
*   **速度警告**: 当用户拖动速度过快时，在界面显示警告信息。
## 3. 技术选型

*   **操控端 (Web)**: HTML, CSS, JavaScript
*   **服务器 (Go)**: Go 语言, WebSocket 库 (`gorilla/websocket`)
*   **被控端 (Web)**: HTML, CSS, JavaScript
*   **设备接口**: Intiface Core (通过 WebSocket `ws://localhost:12345`)
*   **通信协议**: WebSocket + JSON

## 4. 最终架构

```
+-------------------+        +---------------------------------+        +------------------------+
|    操控端 (Web)    |        |          服务器 (Go)            |        |    被控端 (Web)         |
| (远程用户浏览器)  |        |                                 |        | (玩具连接电脑浏览器)   |
|                   |        | +-----------------------------+ |        | +--------------------+ |
| +---------------+ | ====> | | WebSocket 服务器             | | ====> | | WebSocket 客户端   | |
| |  用户界面      | | 控制  | | - 接收控制意图              | | Buttplug| | (连接服务器)       | |
| |  HTML/CSS/JS   | | 意图  | | - 应用限制                  | | JSON    | +--------------------+ |
| +---------------+ |       | | - 构造 Buttplug JSON 消息   | | 消息    |        |               |
|        |          |       | |   (Duration=Dynamic)        | |        |        v               |
|        v          |       | +-----------------------------+ |        | +--------------------+ |
| +---------------+ |        |                                 |        | | JS WebSocket       | | ====> Intiface Core
| |  控制逻辑      | |        |                                 |        | | (直连 Intiface)    | | (ws://localhost:12345)
| | (高频采样+平滑)| |        |                                 |        | +--------------------+ |
| +---------------+ |        |                                 |        |                   |
+-------------------+        +---------------------------------+        +------------------------+
```

**信息流:**
1.  操控端在拖动时进行**高频内部采样**，并将样本存入缓冲区。
2.  操控端根据用户设置的**指令发送间隔** (`sampleIntervalMs`)，定时触发指令构造。
3.  指令构造时，分析缓冲区计算**平滑速度**，获取最新位置，并将位置**映射到用户设定的行程范围**。
4.  操控端将处理后的控制意图 (`{position, speed, sampleIntervalMs}`) 发送到服务器。
5.  服务器接收意图，获取被控端报告的 `deviceIndex` 和自己记录的 `lastCommandedPosition`。
6.  服务器根据收到的 `speed` 和 `position` 与 `lastCommandedPosition` 的差值，**动态计算** `LinearCmd` 的 `Duration`，并应用严格的上下限（如 30ms-90ms）。
7.  服务器将构造好的 Buttplug JSON 转发给被控端，并更新 `lastCommandedPosition`。
8.  被控端将收到的 Buttplug JSON 通过本地 WebSocket 连接发送给 Intiface Core。
7.  Intiface Core 控制玩具。

## 5. 组件职责 (当前实现)

*   **操控端 (Web) (`controller/`)**:
    *   **提供用户界面**:
        *   **主控制区**:
            *   使用垂直的**圆柱体 (模拟男性生殖器，顶部有模拟龟头)** 和**套筒 (模拟飞机杯/默认套筒)** 可视化行程。
            *   用户通过在圆柱体区域上下滑动来控制套筒的**底部边缘**位置，该位置映射为行程 (0% 在底部, 100% 在顶部)。
            *   显示当前映射后的行程百分比、估算速度和速度警告。
        *   **设置面板 (通过顶部 ⚙️ 按钮访问)**:
            *   **行程范围** (%): 使用自定义**双柄范围滑块**设置最小和最大行程值 (默认 1%-99%)。
            *   **最大速度** (%) 滑块。
            *   **指令发送间隔** (ms) 滑块。
            *   **滑块样式选择**: 单选按钮切换“默认套筒”和“飞机杯”样式 (飞机杯为默认)。
            *   **飞机杯半透明**: 复选框控制飞机杯样式是否半透明 (默认开启)。
            *   **控制模式切换**: 单选按钮切换“手动控制”和“体感 (待实现)”模式。
    *   **精度模式逻辑**:
        *   **高频内部采样**: 使用 `requestAnimationFrame` (或 `setTimeout`) 在拖动时持续采样**垂直触摸/鼠标位置** (映射为 0-1) 和时间戳，存入缓冲区 (`sampleBuffer`)。
        *   **指令发送**: 使用 `setInterval`，间隔由“指令发送间隔”滑块 (`currentSampleIntervalMs`) 控制，定时调用 `constructAndSendCommand`。
        *   `constructAndSendCommand` 函数:
            *   从 `sampleBuffer` 中获取最新位置 (`targetPos`)。
            *   基于 `sampleBuffer` 中最早和最新的样本计算**平滑平均速度** (`calculatedSpeed`)。
            *   检查原始速度是否超阈值，更新**速度警告** UI。
            *   应用最小速度值 (`MIN_DRAG_SPEED_VALUE`)。
            *   将 `targetPos` (0-1) **映射**到用户通过双柄滑块设置的行程范围 (`[minStrokeValue, maxStrokeValue]`) 得到 `limitedPos`。
            *   应用用户设置的最大速度限制得到 `limitedSpeed`。
            *   调用 `sendControlCommand` 发送包含 `limitedPos`, `limitedSpeed` 和 `sampleIntervalMs` 的 `control` 消息给服务器。
    *   **事件处理**:
        *   `pointerdown` (垂直滑块容器): 设置 `isDragging=true`，计算初始位置，启动高频采样循环和指令发送定时器。
        *   `pointermove` (垂直滑块容器): 更新当前位置 (`currentRawPosition`)。
        *   `pointerup` (垂直滑块容器): 设置 `isDragging=false`，停止高频采样和指令发送定时器。**不发送**显式停止指令。
        *   `pointerleave` (垂直滑块容器): 触发 `pointerup` 逻辑，并发送安全停止指令。
        *   `pointerdown/move/up` (双柄滑块): 处理拖动逻辑，更新 `minStrokeValue`, `maxStrokeValue` 和 UI 显示。
        *   `sample-interval` 滑块 `input`: 更新 `currentSampleIntervalMs` 并重启指令发送定时器（如果正在运行）。
        *   **设置面板交互**: 处理设置按钮、关闭按钮、样式选择、透明度切换的事件。
    *   **模式切换**: 根据设置面板中的单选按钮状态处理模式切换逻辑，停止相关定时器。
    *   通过 WebSocket 连接到服务器 (`/ws?type=controller`)。

*   **服务器 (Go) (`server/`)**:
    *   提供静态文件服务 (`/controller/`, `/client/`) 和根路径重定向。
    *   实现 WebSocket 服务器 (`/ws`)，区分 `controller` 和 `client` 连接。
    *   管理连接，存储 `client` 报告的 `clientDeviceIndex` 和服务器上次发送的 `lastCommandedPosition`。
    *   **处理来自 Controller 的消息**:
        *   接收 `ControlMessage` (`{type, position, speed, sampleIntervalMs}`)。
        *   获取存储的 `clientDeviceIndex` 和 `lastCommandedPosition`。
        *   调用 `constructLinearCmd` (传递所有参数) 或 `constructStopCmd`。
        *   如果指令成功发送，更新 `lastCommandedPosition`。
    *   **处理来自 Client 的消息**:
        *   接收 `MessageFromClient` (`{type, index}`)。
        *   处理 `setDeviceIndex` 消息，更新存储的 `clientDeviceIndex`，并在索引变化时重置 `lastCommandedPosition`。
    *   **Buttplug JSON 构造**:
        *   `constructLinearCmd`: 接收 `deviceIndex`, `targetPosition`, `speed`, `sampleIntervalMs`, `lastCommandedPosition`。
            *   **动态计算 Duration**: 根据 `speed` 和 `targetPosition` 与 `lastCommandedPosition` 的差值 (`deltaPos`) 计算理论时长。
            *   **应用限制**: 将计算出的 `Duration` 限制在 `[minSafetyDuration, maxCalculatedDuration]` (例如 30ms-90ms) 范围内。若无法计算或速度过低，则使用 `minSafetyDuration`。
        *   `constructStopCmd`: 接收 `deviceIndex`。
    *   将构造好的 Buttplug JSON 消息转发给对应的 `client` 连接。

*   **被控端 (Web) (`client/`)**:
    *   提供简单的界面显示连接状态。
    *   建立到服务器的 WebSocket 连接 (`/ws?type=client`)。
    *   建立到本地 Intiface Core 的 WebSocket 连接 (`ws://localhost:12345`)。
    *   **Intiface 交互**:
        *   连接成功后发送 `RequestServerInfo` 握手消息。
        *   收到 `ServerInfo` 后发送 `RequestDeviceList`。
        *   处理 `DeviceList`，查找第一个支持 `LinearCmd`（或第一个）设备，获取其 `DeviceIndex`。
        *   将获取到的 `DeviceIndex` 通过 `setDeviceIndex` 消息发送回服务器。
        *   处理 `DeviceAdded` / `DeviceRemoved` 并相应更新/通知服务器。
    *   **指令转发**: 将从服务器收到的 Buttplug JSON 字符串原封不动地转发给 Intiface Core。

## 6. 关键实现考量

*   **指令发送间隔 (`sampleIntervalMs`)**: 用户调整此值以控制指令发送频率。较小的值（如 50ms）配合服务器端的短 Duration 可能更流畅，但需考虑网络延迟和设备处理能力。
*   **高频内部采样**: 控制器使用 `requestAnimationFrame` 进行高频采样，以捕捉快速操作，独立于指令发送间隔。
*   **`LinearCmd` Duration**: 服务器动态计算，但严格限制在较短范围内（如 30-90ms），依赖控制器发送的密集指令来实现平滑。
*   **速度计算**: 控制器基于采样缓冲区计算平滑速度，发送给服务器用于 Duration 计算。
*   **行程范围**: 使用自定义双柄滑块，允许用户精确控制活动范围，默认 1%-99% 以规避潜在的端点问题。
*   **设备兼容性**: 不同设备对短 Duration 指令的响应可能不同。
*   **错误处理与状态同步**: 当前实现比较基础，可以进一步完善。
*   **手机传感器**: 体感模式尚未实现。

## 7. 状态与后续步骤

1.  [X] 搭建项目基本结构。
2.  [X] 实现服务器端 WebSocket 基础和静态文件服务。
3.  [X] 实现被控端 Web App 的双 WebSocket 连接和 Intiface 握手/设备发现/索引上报。
4.  [X] 实现操控端 Web App 的 UI（滑块、限制、间隔、模式切换）。
5.  [X] 实现服务器端 Buttplug JSON 构造（Duration = SampleInterval）。
6.  [X] 实现操控端 Web App 的“精度”模式控制逻辑（Interval 采样）。
7.  [X] 迭代调试解决连接、设备索引、指令卡顿、最终定位等问题。
8.  **当前**:
    *   通过多次迭代，实现了基于高频采样、平滑速度计算、动态且有界的 Duration 以及自定义行程范围的控制逻辑，显著改善了流畅度和端点问题。
    *   **重构了操控端 UI**:
        *   将水平滑块替换为垂直的圆柱体+套筒可视化。
        *   优化了圆柱体和套筒（飞机杯/默认）的视觉样式。
        *   将设置项（范围、速度、间隔、模式、样式、透明度）移入可展开的设置面板，优化移动端布局。
        *   调整了交互逻辑以适应垂直滑动和新的 UI 元素。
9.  **后续**:
    *   进行更全面的测试和参数调优（特别是 `maxCalculatedDuration` 和不同 `sampleIntervalMs` 的效果）。
    *   （可选）实现手机摇动控制模式。
    *   （可选）增加更复杂的配对/多用户逻辑。
    *   （可选）进一步美化 UI 和交互细节。
