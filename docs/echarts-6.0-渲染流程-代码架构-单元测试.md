## ECharts 6.0 渲染流程 · 代码架构 · 单元测试指南

> 适用分支：基于 ECharts v6.0.0。本指南帮助你快速理解 ECharts 的渲染主流程、核心代码结构以及如何编写/运行单元测试。

### 目录
- 渲染流程总览
- 核心代码架构与模块职责
- 生命周期与更新阶段（setOption/Action/增量渲染）
- 进阶主题：进度式渲染、Large 模式、脏矩形
- 单元测试：Jest 配置、常用 Helper、示例
- 快速定位代码与常见问题

---

## 渲染流程总览

从用户 API 触发到最终绘制的高层流程如下：

```mermaid
flowchart LR
  U[用户] -->|echarts.init(dom, theme, opts)| I[实例 ECharts]
  I -->|setOption(option, opts)| GM[GlobalModel]
  GM -->|mount/merge/reset| OPT[OptionManager]
  GM -->|restoreData| SCH[Scheduler]
  SCH --> DP[Data Processors]
  SCH --> VS[Visual Encoders]
  SCH --> LY[Layout]
  SCH --> VR[Series/Component Views]
  VR --> ZR[zrender Painter(Canvas/SVG)]
  ZR --> Paint[绘制到 Canvas/SVG]
```

- 初始化：`echarts.init` 创建实例、注册连接组、挂载 renderer（Canvas 或 SVG）。
- 配置：`setOption` 通过 `OptionManager` 规范化/合并配置，`GlobalModel` 构建/更新组件与系列模型树。
- 调度：`Scheduler` 重建流水线（pipeline），按阶段执行数据处理（processor）、视觉编码（visual）、布局（layout）、视图渲染（view）。
- 绘制：`ChartView/ComponentView` 产出 zrender 图形元素，由 zrender Painter 统一绘制到 Canvas 或 SVG。

关联源码（行内引用）：
- 实例初始化 `init(...)`：见下方代码引用 A
- `setOption` 合并入口：见下方代码引用 B
- `GlobalModel._resetOption` 主流程：见下方代码引用 C
- 调度器构造与阶段执行：见下方代码引用 D/E/F/G
- 视图渲染与增量流程：见下方代码引用 H/I
- 扩展 API 能力映射：见下方代码引用 J
- 渲染器注册（Canvas/SVG）：见下方代码引用 K/L

---

## 核心代码架构与模块职责

### 顶层入口与装配（use/install 模式）
- 入口文件 `src/echarts.ts`：默认安装 Canvas 渲染器与 Dataset 组件，暴露 `init`。
- 组件/图表均通过 install 模式注册，便于“按需引入”，如折线图：

```ts
// src/chart/line/install.ts（节选）
export function install(registers) {
  registers.registerChartView(LineView);
  registers.registerSeriesModel(LineSeries);
  registers.registerLayout(layoutPoints('line', true));
  registers.registerVisual({ seriesType: 'line', reset: ... });
  registers.registerProcessor(registers.PRIORITY.PROCESSOR.STATISTIC, dataSample('line'));
}
```

- 渲染器接入：
  - `installCanvasRenderer.ts` 将 zrender `CanvasPainter` 注册为 `canvas` 渲染器。
  - `installSVGRenderer.ts` 注册 `svg` 渲染器。

### ECharts 实例（核心外观）
- 类定义与实例 API：`src/core/echarts.ts`
  - 公共方法：`setOption`、`dispatchAction`、`getOption`、`on/off`、`getDataURL` 等。
  - 管理实例生命周期、分组连接（`connect/disconnect`）。

### 全局模型（GlobalModel）
- 位置：`src/model/Global.ts`
- 作用：承载完整的配置树与所有组件/系列的模型对象；实现 `setOption/resetOption/restoreData`、组件拓扑遍历与依赖处理。
- 关键点：
  - `OptionManager` 统一入参与 merge 策略（支持 `replaceMerge`）。
  - 组件/系列类注册与实例化、缺失组件日志提示（开发期）。

### 调度器（Scheduler）与任务（Task）
- 调度器：`src/core/Scheduler.ts`
  - 负责构建每个系列的流水线（pipeline），组织阶段处理器：数据处理（processor）、视觉编码（visual）、布局与渲染。
  - 进度式渲染：按数据量与阈值拆分多个 frame 执行（`progressiveRender`）。
- 任务系统：`src/core/task.ts`
  - Task 生命周期：`plan → reset → progress`，支持分片（step）、取模分发（mod）等。
  - 上下游链路：每个系列构成从数据到视图的任务链，便于增量与并行调度。

### 视图层（View）
- 图表视图基类：`src/view/Chart.ts`
  - 需实现的关键方法：`render`、可选 `incrementalPrepareRender/incrementalRender`、`updateTransform`。
  - 每个视图管理一个 `zrender.Group`，负责将业务数据映射为图形元素。
- 组件视图基类：`src/view/Component.ts`（同理，不在此展开）。

### 坐标系与数据层
- 坐标系：`src/coord/*`（笛卡尔、极坐标、地理等）。
- 数据容器：`src/data/SeriesData.ts`，提供高效的数据存取与视觉通道（visual）存取。

---

## 生命周期与更新阶段

### 初始化（init）
- 入口：`init(dom, theme, opts)` 创建 `ECharts` 实例，注册到 DOM 与全局实例表，触发生命周期 `afterinit`。
- 选项 `opts.renderer` 选择 `canvas`/`svg`；`opts.useDirtyRect` 可开启脏矩形。

### 设置配置（setOption）
- 合并策略：
  - 默认增量合并；可使用 `{ replaceMerge: 'series' | ['series', 'legend', ...] }` 替换指定主类型。
  - `OptionPreprocessor` 预处理，在 `registerPreprocessor` 收集。
- 模型重建：`GlobalModel._resetOption()` 完成 mount/merge，之后：
  1) `restoreData` 调用各组件/系列 `restoreData`
  2) `Scheduler.restorePipelines` 重建流水线
  3) `prepareStageTasks → performDataProcessorTasks → performVisualTasks → performSeriesTasks`

代码引用 C（`GlobalModel._resetOption` 主流程片段）：
```251:306:src/model/Global.ts
private _resetOption(
    type: 'recreate' | 'timeline' | 'media',
    opt: InnerSetOptionOpts
): boolean {
    let optionChanged = false;
    const optionManager = this._optionManager;

    if (!type || type === 'recreate') {
        const baseOption = optionManager.mountOption(type === 'recreate');
        if (__DEV__) {
            checkMissingComponents(baseOption);
        }

        if (!this.option || type === 'recreate') {
            initBase(this, baseOption);
        }
        else {
            this.restoreData();
            this._mergeOption(baseOption, opt);
        }
        optionChanged = true;
    }
    // ... timeline/media 处理与合并 ...
    return optionChanged;
}
```

### 渲染与增量（progressive）
- `Scheduler.updateStreamModes` 基于数据量与 `progressiveThreshold` 决定是否进度式渲染。
- 当启用进度式：
  - 视图先走 `incrementalPrepareRender`，随后在多个 `progress` 循环中调用 `incrementalRender`。
  - 未启用时直接执行一次 `render`。

代码引用 D（调度器构造与处理器汇总）：
```102:137:src/core/Scheduler.ts
class Scheduler {
  constructor(
    ecInstance: EChartsType,
    api: ExtensionAPI,
    dataProcessorHandlers: StageHandlerInternal[],
    visualHandlers: StageHandlerInternal[]
  ) {
    this.ecInstance = ecInstance;
    this.api = api;
    dataProcessorHandlers = this._dataProcessorHandlers = dataProcessorHandlers.slice();
    visualHandlers = this._visualHandlers = visualHandlers.slice();
    this._allHandlers = dataProcessorHandlers.concat(visualHandlers);
  }
}
```

代码引用 E（进度式模式判定与上下文）：
```207:232:src/core/Scheduler.ts
updateStreamModes(seriesModel, view) {
  const pipeline = this._pipelineMap.get(seriesModel.uid);
  const dataLen = seriesModel.getData().count();
  const progressiveRender = pipeline.progressiveEnabled
    && view.incrementalPrepareRender
    && dataLen >= pipeline.threshold;
  const large = seriesModel.get('large') && dataLen >= seriesModel.get('largeThreshold');
  const modDataCount = seriesModel.get('progressiveChunkMode') === 'mod' ? dataLen : null;
  seriesModel.pipelineContext = pipeline.context = { progressiveRender, modDataCount, large };
}
```

代码引用 F（阶段任务执行）：
```291:302:src/core/Scheduler.ts
performDataProcessorTasks(ecModel, payload?) {
  this._performStageTasks(this._dataProcessorHandlers, ecModel, payload, { block: true });
}
performVisualTasks(ecModel, payload?, opt?) {
  this._performStageTasks(this._visualHandlers, ecModel, payload, opt);
}
```

代码引用 G（阻塞点规划）：
```389:401:src/core/Scheduler.ts
plan() {
  this._pipelineMap.each(function (pipeline) {
    let task = pipeline.tail;
    do {
      if (task.__block) {
        pipeline.blockIndex = task.__idxInPipeline;
        break;
      }
      task = task.getUpstream();
    } while (task);
  });
}
```

### 交互与动作（Action）
- 注册动作：`registerAction({ type, event, update, action, refineEvent })`
- 分发动作：`dispatchAction(payload, opt)` → 写入 `payload` 并触发相应阶段更新（如 `updateView`/`updateVisual`）。
- 连接组（`connect`）会在动作分发时同步其他实例（同组）。

### 细粒度时序（setOption → 渲染）
- 1) 用户调用 `chart.setOption(option, opts)` → `GlobalModel.setOption` 合并配置（见代码引用 B）
- 2) `GlobalModel._resetOption` 进行 mount/merge/timeline/media 处理（见代码引用 C）
- 3) `restoreData` 调用全部组件/系列 `restoreData`，为新一轮处理清场
- 4) `Scheduler.restorePipelines` 重建每个系列的流水线（pipeline）
- 5) `Scheduler.prepareStageTasks` 汇总全部处理器为任务（processors/visuals/layout/views）
- 6) `performDataProcessorTasks`（阻塞）→ `performVisualTasks` → `performSeriesTasks`（见代码引用 F）
- 7) `Scheduler.updateStreamModes` 决定是否进入进度式渲染（见代码引用 E）
- 8) 视图层 `ChartView.reset` 返回渲染策略：`incrementalPrepareRender` 或 `render`（见代码引用 H/I）
- 9) zrender 将 `Group` 中的元素绘制到 Canvas/SVG（渲染器注册见代码引用 K/L）

注：若通过 `dispatchAction` 更新交互态，仅触发必要阶段（通常是 `updateView`/`updateVisual`），避免全量数据处理。

### 局部更新最小示例

示例 1：仅更新数据（使用 `id` 精准匹配系列，避免重建）
```ts
// 初始化
const chart = echarts.init(el);
chart.setOption({
  series: [{ id: 's1', type: 'line', data: [1, 2, 3] }]
});

// 仅数据更新（默认合并）
chart.setOption({
  series: [{ id: 's1', data: [2, 3, 4, 5] }]
});
```

示例 2：仅更新视觉/状态（优先考虑 `dispatchAction`，避免数据重处理）
```ts
// 高亮部分数据点（仅更新视图/视觉阶段）
chart.dispatchAction({ type: 'highlight', seriesId: 's1', dataIndex: [0, 2] });

// 或仅调整样式（触发视觉阶段）
chart.setOption({
  series: [{ id: 's1', lineStyle: { width: 3 } }]
});
```

提示：如果需要替换整个系列集合，使用精确替换避免历史残留：
```ts
chart.setOption({ series: newSeries }, { replaceMerge: ['series'] });
```

代码引用 A（实例初始化）：
```2785:2833:src/core/echarts.ts
export function init(dom?, theme?, opts?): EChartsType {
  const isClient = !(opts && opts.ssr);
  // ... DOM 校验与已存在实例检查 ...
  const chart = new ECharts(dom, theme, opts);
  chart.id = 'ec_' + idBase++;
  instances[chart.id] = chart;
  isClient && modelUtil.setAttribute(dom, DOM_ATTRIBUTE_KEY, chart.id);
  enableConnect(chart);
  lifecycle.trigger('afterinit', chart);
  return chart;
}
```

代码引用 B（`setOption` 入口）：
```216:235:src/model/Global.ts
setOption(option, opts, optionPreprocessorFuncs) {
  const innerOpt = normalizeSetOptionInput(opts);
  this._optionManager.setOption(option, optionPreprocessorFuncs, innerOpt);
  this._resetOption(null, innerOpt);
}
```

代码引用 H（视图任务 reset→选择渲染方法）：
```270:292:src/view/Chart.ts
const progressiveRender = seriesModel.pipelineContext.progressiveRender;
const updateMethod = payload && inner(payload).updateMethod;
const methodName = progressiveRender
  ? 'incrementalPrepareRender'
  : (updateMethod && view[updateMethod]) ? updateMethod : 'render';
if (methodName !== 'render') {
  (view[methodName] as any)(seriesModel, ecModel, api, payload);
}
return progressMethodMap[methodName];
```

代码引用 I（`progress` 阶段调用具体渲染）：
```295:315:src/view/Chart.ts
const progressMethodMap = {
  incrementalPrepareRender: {
    progress(params, context) {
      context.view.incrementalRender(params, context.model, context.ecModel, context.api, context.payload);
    }
  },
  render: {
    forceFirstProgress: true,
    progress(params, context) {
      context.view.render(context.model, context.ecModel, context.api, context.payload);
    }
  }
};
```

代码引用 J（扩展 API 能力映射）：
```31:60:src/core/ExtensionAPI.ts
const availableMethods: (keyof EChartsType)[] = [ 'getDom', 'getZr', 'getWidth', 'getHeight', 'getDevicePixelRatio', 'dispatchAction', 'isSSR', 'isDisposed', 'on', 'off', 'getDataURL', 'getConnectedDataURL', 'getOption', 'getId', 'updateLabelLayout' ];
class ExtensionAPI {
  constructor(ecInstance: EChartsType) {
    zrUtil.each(availableMethods, function (methodName: string) {
      (this as any)[methodName] = zrUtil.bind((ecInstance as any)[methodName], ecInstance);
    }, this);
  }
}
```

代码引用 K/L（渲染器注册）：
```23:25:src/renderer/installCanvasRenderer.ts
export function install(registers) {
  registers.registerPainter('canvas', CanvasPainter);
}
```
```23:25:src/renderer/installSVGRenderer.ts
export function install(registers) {
  registers.registerPainter('svg', SVGPainter);
}
```

---

## 进阶主题

### 进度式渲染（Progressive）与 Large 模式
- Progressive：
  - 面向“逐帧绘制”，阈值与步长来自系列 `getProgressive/getProgressiveThreshold` 与 pipeline 配置。
  - 目标：在大数据量下保证交互流畅。
- Large：
  - `series.large: true` 且数据量超阈值 `largeThreshold` 时启用，通常切换到更轻量的渲染路径。

### 脏矩形（Dirty Rect）
- 通过 `opts.useDirtyRect` 开启，减少重绘区域，提升更新性能（依赖 zrender 对象级脏标记传播）。

---

## 单元测试

### 配置与脚手架
- 配置文件：`test/ut/jest.config.cjs`
  - `preset: ts-jest`，`testEnvironment: jsdom`
  - `setupFiles: ['jest-canvas-mock', '<rootDir>/core/setup.ts']`
  - `transformIgnorePatterns: ['node_modules/(?!zrender/)']` — 确保转换 zrender 源码
  - 测试路径：`**/spec/**.test.ts`

常用脚本（根 `package.json`）：
- 运行单测：`npm test`
- 指定单测：`npm run test:single -- -t "关键字"`
- 可视化回归（本仓库包含丰富的手工用例）：`npm run test:visual`

### 常用 Helper
- `test/ut/core/utHelper.ts` 提供快捷的创建/销毁图表与视图访问：

```ts
import { createChart, removeChart, getECModel } from '../core/utHelper';

const chart = createChart({ width: 500, height: 400 });
chart.setOption({ series: [{ type: 'line', data: [1,2,3] }] });
// 断言模型或视图
const ecModel = getECModel(chart);
// ...
removeChart(chart);
```

相关源码引用（单测与 Helper）：
```23:54:test/ut/jest.config.cjs
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  setupFiles: ['jest-canvas-mock', '<rootDir>/core/setup.ts'],
  transformIgnorePatterns: ["node_modules/(?!zrender/)"]
}
```
```33:61:test/ut/core/utHelper.ts
export function createChart(...) {
  // 创建隐藏 DOM 并调用 init
  const chart = init(el, params.theme, params.opts);
  return chart;
}
```

- 注意：单测默认使用 `src/echarts.all`（完整构建）方便测试；按需构建时需在用例内手动 `use([Chart/Component, Renderer])`。

### 编写断言的建议
- 模型层：断言 `GlobalModel.getComponent/eachSeries` 行为、`replaceMerge` 等合并策略。
- 视图层：断言 `group` 内元素数量/属性（可通过 `getViewGroup` 获取）。
- 交互层：`dispatchAction` 后仅断言受影响的阶段（`updateView/updateVisual`）。

---

## 快速定位代码与常见问题

### 重要目录
- `src/core/echarts.ts`：实例、注册与生命周期、`init/setOption/dispatchAction` 全入口。
- `src/model/Global.ts`：全局模型，配置管理与组件/系列模型维护。
- `src/core/Scheduler.ts` / `src/core/task.ts`：调度与任务系统，进度式执行的核心。
- `src/view/Chart.ts` / `src/view/Component.ts`：视图基类与渲染约定。
- `src/charts/**/install.ts`、`src/component/**/install*.ts`：图表/组件的注册入口。
- `src/renderer/install*.ts`：Canvas/SVG 渲染器注册。

实例：折线图安装入口：
```30:57:src/chart/line/install.ts
export function install(registers) {
  registers.registerChartView(LineView);
  registers.registerSeriesModel(LineSeries);
  registers.registerLayout(layoutPoints('line', true));
  registers.registerVisual({ seriesType: 'line', reset: ... });
  registers.registerProcessor(registers.PRIORITY.PROCESSOR.STATISTIC, dataSample('line'));
}
```

### 常见问题
- 运行时报“组件/系列未引入”：需要 `use([GridComponent, LineChart, CanvasRenderer])` 按需注册（开发态会在 `GlobalModel` 中提示缺失）。
- 大数据量卡顿：启用 `series.progressive` 或 `large`/`largeThreshold`，并避免复杂阴影/渐变等样式。
- 更新性能：尽量使用 `dispatchAction` 改变交互态；仅在必要时 `setOption`，并配合 `replaceMerge` 精准替换。

---

## 参考与版本信息
- 本分支版本：`package.json` → `version: 6.0.0`，依赖 `zrender: 6.0.0`。
- 浏览更多示例：`test/` 目录包含上千个可视化用例（HTML），可用于人工回归与调试。

以上内容覆盖渲染主流程、核心结构与测试方法，建议从 `src/core/echarts.ts` 与 `src/core/Scheduler.ts` 开始阅读源码，再结合 `src/charts/*/install.ts` 了解具体图表的视图实现细节。

---

## 附录：柱形图（bar）渲染流程（含源码引用）

### 概览
- 安装注册：系列/视图/布局/抽样处理/排序动作
- setOption → 建模：`BarSeriesModel` 初始化数据、large/progressive 策略
- 阶段处理：数据处理（抽样）→ 布局（柱宽/偏移、逐项布局/large）
- 视图渲染：普通/large/增量路径；diff 新增/更新/移除；裁剪/标签/动画
- 交互：`realtimeSort` 触发 `changeAxisOrder`

### 安装与动作注册
```29:42:src/chart/bar/install.ts
export function install(registers: EChartsExtensionInstallRegisters) {

    registers.registerChartView(BarView);
    registers.registerSeriesModel(BarSeries);

    registers.registerLayout(registers.PRIORITY.VISUAL.LAYOUT, zrUtil.curry(layout, 'bar'));
    registers.registerLayout(registers.PRIORITY.VISUAL.PROGRESSIVE_LAYOUT, createProgressiveLayout('bar'));

    registers.registerProcessor(
        registers.PRIORITY.PROCESSOR.STATISTIC,
        dataSample('bar')
    );
}
```

```53:68:src/chart/bar/install.ts
registers.registerAction({
    type: 'changeAxisOrder',
    event: 'changeAxisOrder',
    update: 'update'
}, function (payload, ecModel) {
    const componentType = payload.componentType || 'series';
    ecModel.eachComponent(
        { mainType: componentType, query: payload },
        function (componentModel) {
            if (payload.sortInfo) {
                (componentModel as CartesianAxisModel).axis.setCategorySortInfo(payload.sortInfo);
            }
        }
    );
});
```

### 系列模型与数据策略
```104:132:src/chart/bar/BarSeries.ts
getInitialData(): SeriesData {
    return createSeriesData(null, this, {
        useEncodeDefaulter: true,
        createInvertedIndices: !!this.get('realtimeSort', true) || null
    });
}
getProgressive() {
    return this.get('large') ? this.get('progressive') : false;
}
getProgressiveThreshold() {
    let progressiveThreshold = this.get('progressiveThreshold');
    const largeThreshold = this.get('largeThreshold');
    if (largeThreshold > progressiveThreshold) {
        progressiveThreshold = largeThreshold;
    }
    return progressiveThreshold;
}
```

### 布局阶段
写入柱宽/偏移：
```443:465:src/layout/barGrid.ts
export function layout(seriesType: string, ecModel: GlobalModel) {
    const seriesModels = prepareLayoutBarSeries(seriesType, ecModel);
    const barWidthAndOffset = makeColumnLayout(seriesModels);
    each(seriesModels, function (seriesModel) {
        const data = seriesModel.getData();
        const cartesian = seriesModel.coordinateSystem as Cartesian2D;
        const baseAxis = cartesian.getBaseAxis();
        const stackId = getSeriesStackId(seriesModel);
        const columnLayoutInfo = barWidthAndOffset[getAxisKey(baseAxis)][stackId];
        data.setLayout({ bandWidth: columnLayoutInfo.bandWidth, offset: columnLayoutInfo.offset, size: columnLayoutInfo.width });
    });
}
```

large/进度式布局：
```469:596:src/layout/barGrid.ts
export function createProgressiveLayout(seriesType: string): StageHandler { /* reset -> progress 逐项生成 largePoints/largeBackgroundPoints */ }
```

### 视图渲染
入口与路径选择：
```142:164:src/chart/bar/BarView.ts
render(seriesModel, ecModel, api, payload) {
    this._updateDrawMode(seriesModel);
    this._isLargeDraw ? this._renderLarge(seriesModel, ecModel, api)
                      : this._renderNormal(seriesModel, ecModel, api, payload);
}
```

普通渲染（diff + 动画/裁剪/样式/标签）：
```193:470:src/chart/bar/BarView.ts
private _renderNormal(...) {
    data.diff(oldData)
      .add((dataIndex) => { /* elementCreator 创建矩形/扇形，initProps 入场 */ })
      .update((newIndex, oldIndex) => { /* 复用/重建，updateProps 过渡 */ })
      .remove((dataIndex) => { /* removeElementWithFadeOut 淡出 */ })
      .execute();
}
```

矩形元素创建（笛卡尔）：
```790:807:src/chart/bar/BarView.ts
cartesian2d(...) { const rect = new Rect({ shape: extend({}, layout), z2: 1 }); /* 初始宽/高动画 */ return rect; }
```

样式与标签：
```1002:1087:src/chart/bar/BarView.ts
updateStyle(el, data, dataIndex, itemModel, layout, seriesModel, isHorizontalOrRadial, isPolar) { /* 圆角/默认文本/位置/值动画/状态 */ }
```

裁剪：
```702:745:src/chart/bar/BarView.ts
cartesian2d(coordSysBoundingRect, layout) { /* 与坐标系相交裁剪，回填 shape 并返回是否完全裁剪 */ }
```

large/增量渲染：
```166:179:src/chart/bar/BarView.ts
incrementalPrepareRender(seriesModel) { this._clear(); this._updateDrawMode(seriesModel); this._updateLargeClip(seriesModel); }
incrementalRender(params, seriesModel) { this._progressiveEls = []; this._incrementalRenderLarge(params, seriesModel); }
```

### 实时排序（realtimeSort）
启用后首帧/后续动态派发 `changeAxisOrder`：
```496:531:src/chart/bar/BarView.ts
private _enableRealtimeSort(realtimeSortCfg, data, api) {
    if (this._isFirstFrame) { this._dispatchInitSort(data, realtimeSortCfg, api); this._isFirstFrame = false; }
    else { this._onRendered = () => { this._updateSortWithinSameData(data, orderMapping, baseAxis, api); }; api.getZr().on('rendered', this._onRendered); }
}
```

### 实用配置提示
- 大数据/流畅更新：`series.bar.large`、`largeThreshold`、必要时 `progressive`
- 实时排序：`series.bar.realtimeSort: true`（类目轴 + cartesian2d）
- 柱宽：`barWidth/barMinWidth/barMaxWidth/barGap/barCategoryGap`
- 背景/圆角：`showBackground/backgroundStyle/borderRadius`