"""把看板渲染树（ui.drawn() 的纯数据）转成网页，近似桌面版的样子，用来截图。"""
import json, sys, html, os
src, outdir = sys.argv[1], sys.argv[2]
SP = {'xs': 4, 'sm': 8, 'md': 12, 'lg': 16}
SIZE = {'title': 20, 'heading': 22, 'footnote': 13, 'caption': 12}
def px(v):
    return f"{SP.get(v, 0)}px" if isinstance(v, str) else f"{v * 8}px"
def color(v):
    return '#d0d7de' if v in ('promptBorder', None) else v
def node(n, parent_dir='column'):
    if isinstance(n, str):
        return html.escape(n)
    if n is None or n is False:
        return ''
    t, p, ch = n.get('type'), n.get('props', {}), n.get('children', [])
    inner = ''.join(node(c) for c in ch) if isinstance(ch, list) else node(ch)
    if t == 'Box':
        st = ['display:flex', f"flex-direction:{p.get('flexDirection', 'row')}", 'box-sizing:border-box', 'min-width:0']
        if p.get('flexWrap'): st.append(f"flex-wrap:{p['flexWrap']}")
        for k, css in (('gap', 'gap'), ('columnGap', 'column-gap'), ('rowGap', 'row-gap'), ('padding', 'padding')):
            if k in p: st.append(f"{css}:{px(p[k])}")
        if 'paddingX' in p: st.append(f"padding-left:{px(p['paddingX'])};padding-right:{px(p['paddingX'])}")
        if 'paddingY' in p: st.append(f"padding-top:{px(p['paddingY'])};padding-bottom:{px(p['paddingY'])}")
        if p.get('alignItems'): st.append(f"align-items:{p['alignItems']}")
        if p.get('justifyContent'): st.append(f"justify-content:{p['justifyContent']}")
        if p.get('borderStyle'): st.append(f"border:1px solid {color(p.get('borderColor'))};border-radius:8px")
        if p.get('backgroundColor'): st.append(f"background:{p['backgroundColor']};border-radius:6px")
        if 'width' in p: st.append(f"width:{p['width']}" if isinstance(p['width'], str) else f"width:{p['width']*8}px")
        if 'minWidth' in p: st.append(f"min-width:{p['minWidth']*8}px")
        return f'<div style="{";".join(st)}">{inner}</div>'
    if t == 'Text':
        st = [f"font-size:{SIZE.get(p.get('size'), 14)}px", 'white-space:pre-wrap']
        if p.get('color'): st.append(f"color:{p['color']}")
        if p.get('backgroundColor'): st.append(f"background:{p['backgroundColor']};border-radius:4px;padding:1px 2px")
        w = p.get('weight')
        if w in ('bold',) or p.get('bold'): st.append('font-weight:700')
        elif w == 'semibold': st.append('font-weight:600')
        elif w == 'medium': st.append('font-weight:500')
        if p.get('dimColor'): st.append('opacity:.62')
        return f'<span style="{";".join(st)}">{inner}</span>'
    if t == 'Button':
        label = html.escape(p.get('label', ''))
        if p.get('plain'):
            return f'<span style="color:#0969da;font-size:13px;cursor:pointer">{label}</span>'
        if p.get('variant') == 'primary':
            return f'<span style="background:#0969da;color:#fff;border-radius:6px;padding:3px 10px;font-size:13px">{label}</span>'
        return f'<span style="border:1px solid #d0d7de;border-radius:6px;padding:3px 10px;font-size:13px;background:#f6f8fa">{label}</span>'
    if t == 'Link':
        return f'<span style="color:#0969da;font-size:13px">{html.escape(p.get("label", ""))}</span>'
    if t == 'Svg':
        return p.get('source', '')
    return inner
for line in open(src, encoding='utf-8'):
    if not line.startswith('@@TREE '):
        continue
    _, name, js = line.rstrip('\n').split(' ', 2)
    body = node(json.loads(js))
    page = f'''<!doctype html><html><head><meta charset="utf-8"><title>{name}</title>
<style>body{{margin:0;padding:16px;background:#fff;color:#1f2328;font-family:-apple-system,"PingFang SC",sans-serif;width:1200px}}
.banner{{font-size:12px;color:#57606a;border-bottom:1px dashed #d0d7de;margin-bottom:10px;padding-bottom:6px}}</style></head>
<body><div class="banner">看板渲染（审批状态分支 claude/board-approval-1387f1）：插件测试工具按 6 个已登记项目的真实卡片数据画出的界面树，转成网页截图；
novel 的 D-37、D-38 通过和 D-41 否决是在副本上模拟的演示数据，不是 lee 的真实审批。</div>{body}<script>document.title="H"+document.documentElement.scrollHeight</script></body></html>'''
    open(os.path.join(outdir, f'{name}.html'), 'w', encoding='utf-8').write(page)
    print(name)
