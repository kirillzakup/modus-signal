"""Optional Edge neural narration. Uses the isolated edge-tts wheel in vendor.
Public, non-sensitive tutorial text only. No account, paid key or browser control.
Upstream usage: https://github.com/rany2/edge-tts
"""
import asyncio
import hashlib
import json
import platform
from pathlib import Path
import sys

from render import digest, duration, run, write_json


def import_edge():
    # This host's WMI query hangs. Fall back to Python's standard Win32 version
    # detection in this process only; no registry/system/package changes.
    if sys.platform=='win32' and hasattr(platform,'_wmi_query'):
        def unavailable_wmi(*args,**kwargs):
            raise OSError('WMI unavailable; use standard Win32 fallback')
        platform._wmi_query=unavailable_wmi
    vendor=Path(__file__).resolve().parent/'vendor'/'edge-direct'
    sys.path.insert(0,str(vendor))
    import edge_tts
    return edge_tts


async def receive(text,mp3,voice,rate):
    edge=import_edge()
    client=edge.Communicate(text,voice,rate=rate,boundary='WordBoundary',
                            connect_timeout=12,receive_timeout=25)
    words=[]
    with mp3.open('wb') as stream:
        async for chunk in client.stream():
            if chunk['type']=='audio':
                stream.write(chunk['data'])
            elif chunk['type']=='WordBoundary':
                words.append(dict(start=chunk['offset']/10_000_000,
                                  end=(chunk['offset']+chunk['duration'])/10_000_000,
                                  text=chunk['text']))
    if not words or mp3.stat().st_size<1000:
        raise RuntimeError('Neural service returned incomplete audio/word timings')
    return words


def captions_from_words(words,text):
    # Restore original punctuation using the exact, verified word sequence.
    positions=[i for i,c in enumerate(text) if c.isalnum()]
    normalize=lambda value: ''.join(c.lower().replace('ё','е') for c in value if c.isalnum())
    if normalize(text)!=''.join(normalize(w['text']) for w in words):
        raise ValueError('Synthesized word transcript differs from narration script')
    spans,cursor=[],0
    for word in words:
        count=len(normalize(word['text']))
        start=positions[cursor]
        cursor+=count
        end=positions[cursor] if cursor<len(positions) else len(text)
        spans.append(dict(word=word,start=start,end=end))
    captions,group=[],[]
    def flush():
        if group:
            captions.append(dict(start=round(group[0]['word']['start'],3),
                                 end=round(group[-1]['word']['end'],3),
                                 text=text[group[0]['start']:group[-1]['end']].strip()))
            group.clear()
    for span in spans:
        if group and (span['end']-group[0]['start']>105 or
                      span['word']['end']-group[0]['word']['start']>6):
            flush()
        group.append(span)
        if text[span['start']:span['end']].strip().endswith(('.', '!', '?', ';')):
            flush()
    flush()
    return captions


def synthesize_neural(scene,output):
    voice='ru-RU-SvetlanaNeural'
    rate='-5%'
    target=output/(scene['id']+'-neural')
    target.mkdir(parents=True,exist_ok=True)
    mp3,wav,subtitles,receipt=[target/name for name in ('voice.mp3','voice.wav','subtitles.json','receipt.json')]
    settings=dict(text=scene['text'],voice=voice,rate=rate,edge_version='7.3.1')
    key=hashlib.sha256(json.dumps(settings,sort_keys=True).encode()).hexdigest()
    if wav.exists() and subtitles.exists() and receipt.exists():
        data=json.loads(receipt.read_text(encoding='utf-8'))
        if (all(data.get('settings',{}).get(k)==v for k,v in settings.items()) and
                data.get('voice_sha256')==digest(wav) and (target/'words.json').exists()):
            words=json.loads((target/'words.json').read_text(encoding='utf-8'))
            captions=captions_from_words(words,scene['text'])
            write_json(subtitles,captions)
            return wav,captions
    words=asyncio.run(asyncio.wait_for(receive(scene['text'],mp3,voice,rate),timeout=90))
    run(['ffmpeg','-v','error','-y','-i',mp3,'-ar','48000','-ac','1','-c:a','pcm_s16le',wav],target/'convert.log')
    captions=captions_from_words(words,scene['text'])
    length=duration(wav)
    if any(c['start']<0 or c['end']>length+.2 or c['end']<=c['start'] for c in captions):
        raise ValueError('Neural word timings do not fit decoded audio')
    write_json(target/'words.json',words)
    write_json(subtitles,captions)
    write_json(receipt,dict(input=key,voice_sha256=digest(wav),settings=settings))
    return wav,captions
