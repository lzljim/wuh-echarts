### ECharts 5.6 分支概览与核心架构

本分支基于 ECharts 5.6（实际版本号见代码为 `6.0.0-beta.1`）的源码组织，文档旨在帮助理解渲染流程、代码架构以及如何进行单元测试。

- **仓库入口**: `src/echarts.ts`、`src/echarts.common.ts`、`src/echarts.simple.ts` 等打包入口
- **渲染核心**: `src/core/echarts.ts`、`src/core/Scheduler.ts`、`src/core/task.ts`
- **模型层**: `src/model/Global.ts`、`src/model/Series.ts`、`src/model/Component.ts`
- **视图层**: `src/view/Chart.ts`、`src/view/Component.ts`
- **数据/视觉流水线**: `src/processor/**`、`src/visual/**`、`src/layout/**`
- **渲染器**: 依赖 `zrender`，在 `src/core/echarts.ts` 中通过 `zrender.init` 初始化 Canvas/SVG 渲染


## 渲染流程概述

ECharts 的渲染主流程由 `ECharts` 类驱动，`Scheduler` 负责组织各阶段任务（数据处理、视觉计算、布局、系列渲染）的执行与增量推进。典型调用路径：

1) 初始化实例

```475:487:src/core/echarts.ts
const zr = this._zr = zrender.init(dom, {
    renderer: opts.renderer || defaultRenderer,
    devicePixelRatio: opts.devicePixelRatio,
    width: opts.width,
    height: opts.height,
    ssr: opts.ssr,
    useDirtyRect: retrieve2(opts.useDirtyRect, defaultUseDirtyRect),
    useCoarsePointer: retrieve2(opts.useCoarsePointer, defaultCoarsePointer),
    pointerSize: opts.pointerSize
});
```

2) 设置配置并构建模型

```624:681:src/core/echarts.ts
chart.setOption(option, notMerge, lazyUpdate);
...
ecModel.init(...);
this._model.setOption(option as ECBasicOption, { replaceMerge }, optionPreprocessorFuncs);
```

3) 调度数据处理与视觉阶段

```1916:1920:src/core/echarts.ts
this._scheduler.performVisualTasks(ecModel, payload, {setDirty: true});
render(this, ecModel, this._api, payload, {});
```

`Scheduler` 将各阶段注册的处理器编织为任务流水线，支持渐进式渲染与按块增量执行：

```121:137:src/core/Scheduler.ts
constructor(ecInstance, api, dataProcessorHandlers, visualHandlers) {
  this._dataProcessorHandlers = dataProcessorHandlers.slice();
  this._visualHandlers = visualHandlers.slice();
  this._allHandlers = dataProcessorHandlers.concat(visualHandlers);
}
```

流水线与增量模式判定：

```207:232:src/core/Scheduler.ts
updateStreamModes(seriesModel, view) {
  const pipeline = this._pipelineMap.get(seriesModel.uid);
  const dataLen = seriesModel.getData().count();
  const progressiveRender = pipeline.progressiveEnabled && view.incrementalPrepareRender && dataLen >= pipeline.threshold;
  const large = seriesModel.get('large') && dataLen >= seriesModel.get('largeThreshold');
  seriesModel.pipelineContext = pipeline.context = { progressiveRender, modDataCount, large };
}
```

系列渲染任务的计划与执行（阻塞点用于分界非增量阶段）：

```389:399:src/core/Scheduler.ts
plan() {
  this._pipelineMap.each(function (pipeline) {
    let task = pipeline.tail;
    do {
      if (task.__block) { pipeline.blockIndex = task.__idxInPipeline; break; }
      task = task.getUpstream();
    } while (task);
  });
}
```

视图侧增量渲染协议由 `ChartView` 约定：

```271:300:src/view/Chart.ts
const methodName = progressiveRender ? 'incrementalPrepareRender' : (updateMethod && view[updateMethod]) ? updateMethod : 'render';
if (methodName !== 'render') { (view[methodName] as any)(seriesModel, ecModel, api, payload); }
return progressMethodMap[methodName];
```


## 架构分层

- **ECharts 实例 (`src/core/echarts.ts`)**: 对外 API（`init`、`setOption`、`resize`、`dispatchAction`），维护模型、视图、调度器与 ZRender 实例。负责生命周期事件与主流程调度。
- **调度器 Scheduler (`src/core/Scheduler.ts`)**: 将注册的处理器（数据处理器、视觉处理器）组织为任务流，维护流水线、增量配置、分块执行与脏标记传播。
- **模型层 (`src/model/**`)**: 
  - `GlobalModel` 维护全局组件与系列的统一视图，负责 `setOption` 合并、组件查找与依赖。
  - `SeriesModel`、`ComponentModel` 定义系列和组件的配置读取、数据访问与状态。
- **视图层 (`src/view/**`)**:
  - `Chart.ts` 定义系列视图协议（`render`、`incrementalPrepareRender`、`incrementalRender`、`updateTransform` 等）。
  - `Component.ts` 定义组件视图协议（`render/remove/dispose`）。
- **处理阶段**:
  - 数据处理器：`src/processor/**`（筛选、统计、堆叠等）。
  - 视觉处理器：`src/visual/**`（调色板、样式、符号、图案等）。
  - 布局阶段：`src/layout/**`（如坐标系、网格、极坐标等布局）。
- **安装与扩展**:
  - 各图表与组件通过 `install.ts` 注册处理器与视图，例如 `src/chart/pie/install.ts`、`src/component/legend/install.ts`。
  - 注册接口涵盖 `registerProcessor`、`registerVisual`、`registerLayout`、`registerAction` 等（见各 `install.ts`）。
- **渲染后端**:
  - 依赖 `zrender`，在 `ECharts` 构造中 `zrender.init(dom, { renderer: 'canvas' | 'svg', ... })` 进行渲染上下文创建，随后由各 `View` 产出图形元素树并交由 zrender 渲染。


## 关键时序（setOption -> 渲染）

1. `setOption` 合并配置，`GlobalModel.setOption` 产出新的模型层结构
2. `Scheduler.restorePipelines` 为每个系列建立流水线，`prepareStageTasks` 构建阶段任务
3. 执行数据处理阶段（过滤/统计/堆叠等）
4. 执行视觉与布局阶段（调色、样式、符号尺寸，布局）
5. 准备/执行系列视图渲染：
   - 普通渲染：`ChartView.render`
   - 渐进式：`ChartView.incrementalPrepareRender` -> 多次 `incrementalRender`
6. 更新组件视图与层级（`renderComponents`）
7. ZRender 刷新帧，触发 `rendered/finished` 等事件


## 目录结构速览（本仓库）

- 源码：`src/**`
- 扩展源码：`extension-src/**`
- 产物：`dist/**`
- 服务端渲染客户端：`ssr/client/**`
- 单测：`test/ut/**`（Jest）
- 可视化回归与示例服务器：`test/runTest/**`（`npm run test:visual`）
- 构建脚本：`build/**`


## 单元测试

- 测试框架：Jest + ts-jest，环境为 `jsdom`
- 配置：`test/ut/jest.config.cjs`

运行命令（来自根 `package.json`）：

```bash
npm test                     # 运行所有单测
npm run test:single -- -t xx # 按名称过滤用例
npm run test:single:debug    # Node Inspector 调试模式
npm run test:visual          # 启动可视化测试服务器（非单测）
```

Jest 关键配置要点：

```23:54:test/ut/jest.config.cjs
preset: 'ts-jest',
testEnvironment: 'jsdom',
setupFiles: ['jest-canvas-mock', '<rootDir>/core/setup.ts'],
setupFilesAfterEnv: ['<rootDir>/core/extendExpect.ts'],
transformIgnorePatterns: ['node_modules/(?!zrender/)'],
testMatch: [ '**/spec/api/*.test.ts', '**/spec/component/**/*.test.ts', ... ],
moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' })
```

测试辅助：

- 创建/销毁图表：`test/ut/core/utHelper.ts`

```33:61:test/ut/core/utHelper.ts
export function createChart(params?) { /* 创建隐藏 DOM，init 并返回实例 */ }
export function removeChart(chart) { chart.dispose(); }
```

- 断言扩展：`test/ut/core/extendExpect.ts` 增加如 `toBeFinite` 等断言

- 示例用例：

```101:117:test/ut/spec/api/containPixel.test.ts
beforeEach(() => { chart = createChart({ width: 200, height: 150 }); });
afterEach(() => { removeChart(chart); });
chart.setOption({ geo: [...], series: [...] });
expect(chart.containPixel('geo', [15, 30])).toEqual(true);
```


## 构建与入口产物

常用脚本（根 `package.json`）：

- **开发**：`npm run dev`（并行快速构建与本地静态服务器）
- **构建**：`npm run build`（`dist/echarts.js`、`echarts.min.js`、`esm` 等）
- **SSR 构建**：`npm run build:ssr`
- **类型测试**：`npm run test:dts`

发行入口映射（`package.json#exports`）将 `dist/*`、`index.*`、`lib/*` 等对外导出。


## 扩展开发指南（简述）

1. 在对应图表/组件目录新增实现与 `install.ts`
2. 在 `install.ts` 中通过 `registerProcessor / registerVisual / registerLayout / registerAction` 完成阶段注册
3. 提供 `Model` 与 `View` 实现，满足 `ChartView` 或 `ComponentView` 协议（含增量渲染可选实现）
4. 在打包入口（如 `src/echarts.all.ts`）中引入 `install` 完成全量注册，或由业务端按需注册


## 调试建议

- 通过 `npm run dev` 启动快速开发；用 `test/ut/spec/**` 单测定位逻辑回归
- 观察调度：在 `Scheduler` 的 `perform*`、`plan` 处打断点确认阶段顺序与增量行为
- 视图渲染问题：关注 `ChartView.render` 与 `incremental*` 的分支流转，以及 ZRender 元素树是否正确挂载


## 相关文件快速索引

- `src/core/echarts.ts`：ECharts 类与主流程、事件、生命周期
- `src/core/Scheduler.ts`：任务调度、流水线、增量控制
- `src/view/Chart.ts` / `src/view/Component.ts`：视图协议与任务适配
- `src/model/Global.ts`：全局模型、`setOption` 合并
- `test/ut/**`：单测入口、配置与用例

