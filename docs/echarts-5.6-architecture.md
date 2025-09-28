### ECharts 5.6 渲染与架构·简明指南

这是一份面向开发者的快速上手与理解指南，帮助你在本分支中高效阅读源码、扩展图表/组件并编写单测。

- **版本说明**: 基于 5.6 分支创建，当前源码版本号为 `6.0.0-beta.1`
- **你将获得**: 渲染流程心智图、分层架构速览、扩展配方、单测方法、常见问题与排错建议


## 一分钟上手

- 安装依赖：`npm i`
- 开发预览（本地服务器 + 快速构建）：`npm run dev`
- 全量构建：`npm run build`
- 单元测试：`npm test`
- 可视化用例服务器：`npm run test:visual`


## 一图看懂渲染流程（心智模型）

```
setOption/resize/dispatchAction
        │
        ▼
   ECharts 实例（src/core/echarts.ts）
        │  组织生命周期、组装模型与视图
        ▼
   Scheduler 调度（src/core/Scheduler.ts）
        │  构建流水线 → 运行阶段任务（数据→视觉→布局）
        ▼
   Series/Component View（src/view/**）
        │  render / incremental* 产出图形元素树
        ▼
   ZRender（Canvas/SVG）实际绘制
```


## 渲染流程（步骤详解）

1) 初始化渲染上下文（Canvas/SVG）：

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

2) `setOption` 合并配置，生成/更新模型（`GlobalModel`）：

```624:639:src/core/echarts.ts
chart.setOption(option, notMerge, lazyUpdate);
...
this._model.setOption(option as ECBasicOption, { replaceMerge }, optionPreprocessorFuncs);
```

3) 调度阶段任务：数据处理 → 视觉与布局 → 视图渲染：

```1916:1920:src/core/echarts.ts
this._scheduler.performVisualTasks(ecModel, payload, { setDirty: true });
render(this, ecModel, this._api, payload, {});
```

4) 渐进式/大数据：由调度器判断并驱动 `ChartView.incremental*`：

```271:292:src/view/Chart.ts
const methodName = progressiveRender ? 'incrementalPrepareRender' : (updateMethod && view[updateMethod]) ? updateMethod : 'render';
if (methodName !== 'render') { (view[methodName] as any)(seriesModel, ecModel, api, payload); }
return progressMethodMap[methodName];
```


## 架构分层（先记住这张表）

- **核心实例**：`src/core/echarts.ts` 管理主流程与生命周期事件
- **调度器**：`src/core/Scheduler.ts` 组织任务流水线与增量推进
- **模型层**：`src/model/**`（`GlobalModel`、`SeriesModel`、`ComponentModel`）
- **视图层**：`src/view/**`（`Chart.ts`、`Component.ts`）
- **阶段处理**：`src/processor/**`、`src/visual/**`、`src/layout/**`
- **安装注册**：各图表/组件的 `install.ts` 完成 registerProcessor/Visual/Layout/Action
- **渲染后端**：ZRender（Canvas/SVG）


## 开发配方（直接照做）

### 新增一个系列图表（Series）

1) 新建目录，例如：`src/chart/myChart/`
2) 实现 `MyChartModel`（继承 `SeriesModel`）与 `MyChartView`（参考 `Chart.ts` 接口）
3) 在 `src/chart/myChart/install.ts` 注册：
   - 数据处理：`registerProcessor`
   - 视觉/布局：`registerVisual`、`registerLayout`
   - 视图与模型：`registerChartView`、`registerSeriesModel`
4) 在入口（如 `src/echarts.all.ts` 或业务侧）`use(install)` 完成装配

提示：若数据量大，优先实现 `incrementalPrepareRender` 与 `incrementalRender` 获得流式渲染体验。

### 新增一个组件（Component）

1) 新建目录，例如：`src/component/myComponent/`
2) 实现 `MyComponentModel` 与 `MyComponentView`
3) 在 `install.ts` 调用：`registerComponentModel`、`registerComponentView`，以及必要的 `registerAction`、`registerLayout`
4) 在入口装配 `install`


## 单元测试（最常用的那几件事）

- 运行命令：

```bash
npm test                     # 运行所有单测
npm run test:single -- -t xx # 名称过滤
npm run test:single:debug    # 调试模式
```

- Jest 配置关键点：

```23:54:test/ut/jest.config.cjs
preset: 'ts-jest',
testEnvironment: 'jsdom',
setupFiles: ['jest-canvas-mock', '<rootDir>/core/setup.ts'],
setupFilesAfterEnv: ['<rootDir>/core/extendExpect.ts'],
transformIgnorePatterns: ['node_modules/(?!zrender/)']
```

- 常用测试工具：`test/ut/core/utHelper.ts`

```33:61:test/ut/core/utHelper.ts
export function createChart(params?) { /* 创建隐藏 DOM，init 并返回实例 */ }
export function removeChart(chart) { chart.dispose(); }
```

- 一个最小用例（结构示例）：

```ts
import { createChart, removeChart } from '../../core/utHelper';

describe('my-feature', () => {
  let chart;
  beforeEach(() => { chart = createChart({ width: 200, height: 150 }); });
  afterEach(() => { removeChart(chart); });

  it('works', () => {
    chart.setOption({ series: [{ type: 'line', data: [1, 2, 3] }] });
    expect(chart.getWidth()).toBeGreaterThan(0);
  });
});
```


## 调试与排错（遇到问题先看这里）

- 看不出流程？在 `src/core/Scheduler.ts` 的 `perform*` 与 `plan` 设置断点，确认阶段顺序与是否进入增量
- 视图不渲染？检查 `ChartView.render` 是否创建并挂载到 `group`，以及是否被布局阶段隐藏/裁剪
- 大数据卡顿？
  - 系列开启 `progressive`/`large` 选项
  - 实现 `incremental*` 接口（见 `Chart.ts` 渐进式协议）
- 单测报错 `Canvas`/`context` 缺失？确保 `jest-canvas-mock` 在 `setupFiles` 中
- zrender 未被转译？确认 `transformIgnorePatterns: ['node_modules/(?!zrender/)']`


## 术语速记（Glossary）

- **Model**：配置的抽象表示，`GlobalModel` 汇总组件与系列；`SeriesModel`、`ComponentModel` 为具体项
- **View**：渲染层实体，`ChartView`/`ComponentView` 负责把模型变成图形元素树
- **Scheduler**：任务编排器，把各阶段 handler 连接为流水线并控制执行/增量
- **StageHandler**：阶段处理函数（数据/视觉/布局），由 `install.ts` 注册
- **Pipeline**：以系列为单位的任务链，承载 `progressive` 等上下文
- **Progressive**：渐进式渲染，分帧输出，提升大数据交互体验


## 目录结构速览

- 源码：`src/**`
- 扩展源码：`extension-src/**`
- 产物：`dist/**`
- SSR 客户端：`ssr/client/**`
- 单测：`test/ut/**`（Jest）
- 可视化/示例：`test/runTest/**`
- 构建脚本：`build/**`


## 常见问题（FAQ）

- 合并规则：`setOption` 默认合并，使用 `{ notMerge: true }` 或 `replaceMerge` 控制替换语义
- 选 Canvas 还是 SVG？默认 Canvas，SVG 在矢量清晰与 SSR 场景更友好，二者通过 `renderer` 切换
- 何时需要渐进式？数据量达到系列 `progressiveThreshold` 且渲染可切分时开启
- 颜色/样式来自哪里？先组件（如 visualMap），后系列/数据项，具体见 `src/visual/**` 执行顺序


## 进一步阅读（精准跳转）

- `src/core/echarts.ts`：主流程、API、生命周期
- `src/core/Scheduler.ts`：任务调度、流水线、增量判断
- `src/view/Chart.ts` / `src/view/Component.ts`：视图协议与增量渲染
- `src/model/Global.ts`：`setOption` 合并与组件/系列管理
- `test/ut/**`：Jest 配置、工具与用例

