import json, glob, os, re
root=os.path.expanduser('~/.claude/projects'); out=[]
SKIP=re.compile(r'^(This session is being continued|# Instructions|你是[^\n]{0,40}(会话|主脑|大脑)|这是 Cohive 接入测试)')
for f in glob.glob(root+'/*/*.jsonl'):
    proj=os.path.basename(os.path.dirname(f)).replace('-Users-jiali-','')
    last_ai=''
    for line in open(f,encoding='utf-8',errors='ignore'):
        try: d=json.loads(line)
        except: continue
        t=d.get('type')
        if d.get('isSidechain'): continue
        if t=='assistant':
            c=d.get('message',{}).get('content')
            if isinstance(c,list):
                txt=' '.join(x.get('text','') for x in c if isinstance(x,dict) and x.get('type')=='text').strip()
                if txt: last_ai=txt
            continue
        if t!='user' or d.get('isMeta'): continue
        c=d.get('message',{}).get('content')
        if isinstance(c,list): c=' '.join(x.get('text','') for x in c if isinstance(x,dict) and x.get('type')=='text')
        if not isinstance(c,str) or not c.strip() or c.lstrip().startswith('<'): continue
        ts=d.get('timestamp','')
        if ts<'2026-10-01' or SKIP.search(c.lstrip()) or len(c)>3000: continue
        out.append({'ts':ts,'proj':proj,'sid':os.path.basename(f)[:8],'prev':last_ai[-400:],'msg':c})
out.sort(key=lambda r:r['ts'])
json.dump(out,open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'lee_msgs.json'),'w'),ensure_ascii=False)
m=sum(len(r['msg']) for r in out); p=sum(len(r['prev']) for r in out)
print('保留',len(out),'条；你的原话',m,'字；附带前文',p,'字')
