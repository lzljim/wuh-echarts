/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.
*/
import type GlobalModel from '../model/Global';
import type ExtensionAPI from '../core/ExtensionAPI';
import type { StageHandlerOverallReset, BoxLayoutOptionMixin } from '../util/types';
import type LegendModel from '../component/legend/LegendModel';
import type VisualMapModel from '../component/visualMap/VisualMapModel';

// 组件信息（分组后每个组件的必要属性）
interface ComponentItem {
    model: LegendModel | VisualMapModel;
    setBox: (box: BoxLayoutOptionMixin) => void;
    paged: boolean;
    actualSize?: { width: number; height: number };
}

// 分组信息（存储分组级别的属性）
interface ComponentGroup {
    position: 'bottom' | 'top' | 'left' | 'right';
    orient: 'horizontal' | 'vertical';
    align: 'start' | 'center' | 'end';  // 从第一个组件获取，默认 center
    items: ComponentItem[];
}

// 常量定义
const COMPONENT_GAP = 10; // 组件间距（像素）
const MIN_COMPONENT_SIZE = 50; // 最小组件尺寸（像素）
const PAGED_LEGEND_WEIGHT = 1.5; // 翻页图例权重

// 计算容器尺寸
function getViewSize(api: ExtensionAPI) {
    return { width: api.getWidth(), height: api.getHeight() };
}

function layoutGroup(
    group: ComponentGroup,
    container: { width: number; height: number }
) {
    const { position, orient, align, items } = group;

    if (items.length === 0) {
        return;
    }

    const horizontal = orient === 'horizontal';
    const totalSpace = horizontal ? container.width : container.height;

    // 1. 扣除间距
    const gapsSpace = Math.max(0, items.length - 1) * COMPONENT_GAP;
    const availableSpace = Math.max(0, totalSpace - gapsSpace);

    // 2. 获取实际尺寸或估算值
    const actualSizes = items.map(item => {
        const size = item.actualSize;
        if (!size) {
            return MIN_COMPONENT_SIZE;
        }
        return horizontal ? size.width : size.height;
    });

    // 3. 应用权重（翻页图例获得更多空间）
    const weightedSizes = actualSizes.map((size, i) => {
        const weight = items[i].paged ? PAGED_LEGEND_WEIGHT : 1.0;
        return size * weight;
    });

    const totalWeightedSize = weightedSizes.reduce((sum, size) => sum + size, 0);

    // 4. 按比例分配空间
    let allocatedSizes: number[];
    if (totalWeightedSize <= availableSpace) {
        // 空间充足，按实际加权尺寸分配
        allocatedSizes = weightedSizes.map(size => Math.floor(size));
    }
    else {
        // 空间不足，按比例缩小
        allocatedSizes = weightedSizes.map(size => {
            const allocated = Math.floor(availableSpace * (size / totalWeightedSize));
            return Math.max(MIN_COMPONENT_SIZE, allocated);
        });
    }

    // 5. 计算对齐偏移（使用分组级别的 align）
    const totalAllocated = allocatedSizes.reduce((sum, size) => sum + size, 0);
    const totalUsed = totalAllocated + gapsSpace;
    const remaining = Math.max(0, totalSpace - totalUsed);

    let alignOffset = 0;
    if (align === 'center') {
        alignOffset = Math.floor(remaining / 2);
    }
    else if (align === 'end') {
        alignOffset = remaining;
    }
    // 'start' 对齐时 alignOffset = 0

    // 6. 写回布局参数
    let currentOffset = alignOffset;
    for (let i = 0; i < items.length; i++) {
        const newBox: BoxLayoutOptionMixin = {};

        if (horizontal) {
            newBox.width = allocatedSizes[i];
            newBox.left = currentOffset;
            if (position === 'bottom') {
                newBox.bottom = 0;
                newBox.top = undefined;
            }
            else {
                newBox.top = 0;
                newBox.bottom = undefined;
            }
            newBox.right = undefined;
            newBox.height = undefined; // 让组件自己决定高度
        }
        else {
            newBox.height = allocatedSizes[i];
            newBox.top = currentOffset;
            if (position === 'right') {
                newBox.right = 0;
                newBox.left = undefined;
            }
            else {
                newBox.left = 0;
                newBox.right = undefined;
            }
            newBox.bottom = undefined;
            newBox.width = undefined; // 让组件自己决定宽度
        }

        items[i].setBox(newBox);
        currentOffset += allocatedSizes[i] + COMPONENT_GAP;
    }
}

const autoLegendLayout: StageHandlerOverallReset = function (ecModel: GlobalModel, api: ExtensionAPI) {
    // 安全检查
    if (!api || !ecModel) {
        return;
    }

    const size = getViewSize(api);
    if (!size || size.width <= 0 || size.height <= 0) {
        return;
    }

    // 按 position 分组
    const groups: Record<string, ComponentGroup> = {};

    // 辅助函数：添加组件到分组
    function addToGroup(
        model: LegendModel | VisualMapModel,
        position: 'bottom' | 'top' | 'left' | 'right',
        orient: 'horizontal' | 'vertical',
        align: 'start' | 'center' | 'end',
        paged: boolean,
        actualSize?: { width: number; height: number }
    ) {
        const key = position;

        if (!groups[key]) {
            // 创建新分组，使用第一个组件的属性
            groups[key] = {
                position,
                orient,
                align,  // 使用第一个组件的 align
                items: []
            };
        }

        // 添加组件到分组
        groups[key].items.push({
            model,
            setBox: (box) => {
                const params: BoxLayoutOptionMixin = {
                    left: box.left,
                    top: box.top,
                    right: box.right,
                    bottom: box.bottom,
                    width: box.width,
                    height: box.height
                };
                model.setAutoLayoutBoxParams(params);
            },
            paged,
            actualSize
        });
    }

    // 收集 legend
    const legends = ecModel.findComponents({ mainType: 'legend' }) as LegendModel[];
    legends.forEach((m) => {
        if (!m || !m.get) {
            return;
        }
        const autoLayoutPosition = m.get('autoLayoutPosition');
        if (!autoLayoutPosition) {
            return;
        }

        const orient = (autoLayoutPosition === 'top' || autoLayoutPosition === 'bottom')
            ? 'horizontal' : 'vertical';
        const position = autoLayoutPosition;
        const align = m.get('autoLayoutAlign') || 'center';
        const isScroll = m.subType === 'scroll';

        // 获取实际渲染尺寸
        let actualSize: { width: number; height: number } | undefined;
        try {
            const legendView = api.getViewOfComponentModel(m);
            if (legendView && legendView.group) {
                const rect = legendView.group.getBoundingRect();
                if (rect && rect.width > 0 && rect.height > 0) {
                    actualSize = { width: rect.width, height: rect.height };
                }
            }
        }
        catch (e) {
            // 获取失败时使用估算值作为后备
            const data = m.get('data') || [];
            const iw = m.get('itemWidth') || 25;
            const ih = m.get('itemHeight') || 14;
            const estimatedSize = orient === 'horizontal'
                ? (data.length * (iw + 12))
                : (data.length * (ih + 8));
            actualSize = orient === 'horizontal'
                ? { width: estimatedSize, height: ih + 10 }
                : { width: iw + 20, height: estimatedSize };
        }

        addToGroup(m, position, orient, align, !!isScroll, actualSize);
    });

    // 收集 visualMap
    const vms = ecModel.findComponents({ mainType: 'visualMap' }) as VisualMapModel[];
    vms.forEach((m) => {
        if (!m || !m.get) {
            return;
        }
        const autoLayoutPosition = m.get('autoLayoutPosition');
        if (!autoLayoutPosition) {
            return;
        }

        const orient = (autoLayoutPosition === 'top' || autoLayoutPosition === 'bottom')
            ? 'horizontal' : 'vertical';
        const position = autoLayoutPosition;
        const align = m.get('autoLayoutAlign') || 'center';

        // 获取实际渲染尺寸
        let actualSize: { width: number; height: number } | undefined;
        try {
            const vmView = api.getViewOfComponentModel(m);
            if (vmView && vmView.group) {
                const rect = vmView.group.getBoundingRect();
                if (rect && rect.width > 0 && rect.height > 0) {
                    actualSize = { width: rect.width, height: rect.height };
                }
            }
        }
        catch (e) {
            // 获取失败时使用估算值作为后备
            const estimatedSize = orient === 'horizontal' ? size.width * 0.2 : size.height * 0.2;
            actualSize = orient === 'horizontal'
                ? { width: estimatedSize, height: 50 }
                : { width: 50, height: estimatedSize };
        }

        addToGroup(m, position, orient, align, false, actualSize);
    });

    // 对每个分组进行布局
    Object.keys(groups).forEach((key) => {
        const group = groups[key];
        layoutGroup(group, size);
    });
};

export default autoLegendLayout;


