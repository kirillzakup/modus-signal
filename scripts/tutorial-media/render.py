"""Real screencast post-production, offline TTS, motion titles, ASS captions.

Commands (paths with spaces must be quoted in the shell):
 python render.py narration manifest.json
 python render.py render manifest.json

Manifest shape; relative paths resolve beside manifest.json:
 {"output":"render", "width":1280, "height":720, "fps":25,
  "crf":22, "disclosure":"Учебный пример", "scenes":[
   {"id":"01", "title":"Обзор", "video":"clips/01.mp4",
    "text":"Первое предложение. Второе предложение.",
    "crop":[0,0,1,1],
    "highlights":[{"start":2,"end":5,"box":[0.1,0.2,0.3,0.2]}]}
  ]}
 crop/highlight box use fractions of source/content area respectively.
 Optional frameTop/frameBottom reserve bands inside the final width x height:
 width=1280,height=900,frameTop=60,frameBottom=120 leaves 1280x720 content.
 When height is omitted it defaults to 720 plus the two band heights.
 Titles stay in the top band and captions in the bottom band when supplied.
 Narration generates each sentence separately, measures its actual WAV duration,
 then concatenates WAV and saves sentence-aligned subtitle JSON. No estimated
 speech timings. Use short sentences: long lines are broken into timed phrases.
 Can also supply voice WAV plus subtitles [{start,end,text}] explicitly.
 Original video audio is excluded; spoken narration is the only audio track.
 Source clips must cover narration+0.5s. hold_seconds explicitly allows a short
 final-frame hold (max 3s); default 0. This never fabricates application actions.
 Optional scene trim_start skips seconds from beginning of captured clip.
 Checkpoints are content hashes; unchanged encoded scenes are reused.
 Master: H.264 CRF22 + AAC 128k. Telegram parts retain master quality and are
 split only at scene/chapter boundaries when the master exceeds 48 MB.
 The generated chapters.json binds timings to exact source and voice hashes.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import textwrap

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')
ROOT = Path(__file__).resolve().parent


def run(args, log=None):
    result = subprocess.run([str(v) for v in args], capture_output=True)
    if log:
        Path(log).write_bytes(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError(result.stderr.decode('utf-8', errors='replace')[-4000:])
    return result.stdout


def probe(path):
    return json.loads(run(['ffprobe','-v','error','-show_format','-show_streams','-of','json',path]))


def duration(path):
    reported=probe(path).get('format',{}).get('duration')
    if reported is not None:
        return float(reported)
    # Browser MediaRecorder WebM often omits container duration. Derive the
    # usable span from real packet timestamps, including variable-rate capture.
    packets=json.loads(run(['ffprobe','-v','error','-select_streams','v:0','-show_packets',
                            '-show_entries','packet=pts_time,duration_time','-of','json',path]))['packets']
    spans=[(float(p['pts_time']),float(p.get('duration_time',0))) for p in packets if 'pts_time' in p]
    if not spans:
        raise ValueError(f'Cannot determine media duration: {path}')
    return max(start+length for start,length in spans)-min(start for start,_ in spans)


def digest(path):
    with Path(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def concat_file(path, clips):
    lines = ["file '" + Path(c).resolve().as_posix().replace("'", "'\\''") + "'" for c in clips]
    Path(path).write_text('\n'.join(lines)+'\n', encoding='utf-8')


def sentence_parts(text):
    # Phrase-level splitting gives each subtitle its own measured synthesized audio.
    parts = re.split(r'(?<=[.!?;])\s+|\n+', text.strip())
    result = []
    for part in parts:
        result.extend(textwrap.wrap(part, 115, break_long_words=False, break_on_hyphens=False))
    return result


def synthesize(scene, output):
    text = str(scene.get('text','')).strip()
    if not text:
        raise ValueError('Narration text is required')
    target = output / (scene['id'] + '-voice')
    target.mkdir(parents=True, exist_ok=True)
    voice_settings=dict(text=text,rate=scene.get('rate',-1),voice='Microsoft Irina Desktop',
                        speech_sha256=digest(ROOT/'speech.ps1'),splitter_version=1)
    words_hash = hashlib.sha256(json.dumps(voice_settings,sort_keys=True).encode()).hexdigest()
    receipt = target / 'receipt.json'
    voice, subtitles = target/'voice.wav', target/'subtitles.json'
    if receipt.exists() and voice.exists() and subtitles.exists():
        cached = json.loads(receipt.read_text(encoding='utf-8'))
        if cached.get('input') == words_hash and cached.get('voice_sha256') == digest(voice):
            return voice, json.loads(subtitles.read_text(encoding='utf-8'))
    chunks, captions, cursor = [], [], 0.0
    for index, phrase in enumerate(sentence_parts(text)):
        txt, wav = target/f'{index:03d}.txt', target/f'{index:03d}.wav'
        txt.write_text(phrase, encoding='utf-8')
        wav.unlink(missing_ok=True)
        run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',ROOT/'speech.ps1',
             '-TextPath',txt,'-OutputPath',wav,'-Rate',scene.get('rate',-1)], target/f'{index:03d}.log')
        length = duration(wav)
        captions.append(dict(start=round(cursor,3), end=round(cursor+length,3), text=phrase))
        chunks.append(wav)
        cursor += length
    listing = target/'audio-concat.txt'
    concat_file(listing,chunks)
    run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','concat','-safe','0',
         '-i',listing,'-c:a','pcm_s16le',voice], target/'concat.log')
    write_json(subtitles,captions)
    write_json(receipt,dict(input=words_hash, voice_sha256=digest(voice)))
    return voice,captions


def stamp(seconds):
    cs = round(max(0,seconds)*100)
    return f'{cs//360000}:{cs//6000%60:02}:{cs//100%60:02}.{cs%100:02}'


def ass_text(text):
    return str(text).replace('\\','/').replace('{','(').replace('}',')').replace('\n',r'\N')


def create_ass(path, scene, captions, length, width, height, disclosure, frame_top=0, frame_bottom=0):
    scale = width/1280 if frame_top or frame_bottom else height/720
    content_height=height-frame_top-frame_bottom
    content_bottom=frame_top+content_height
    head = f'''[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Segoe UI,{27*scale},&H00FFFFFF,&H00FFFFFF,&H00131B29,&H98000000,0,0,0,0,100,100,0,0,3,2,0,2,65,65,{int(28*scale)},1
Style: Title,Segoe UI,{35*scale},&H00FFFFFF,&H00FFFFFF,&H001A263B,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,7,30,30,30,1
Style: Label,Segoe UI,{17*scale},&H00FFFFFF,&H00FFFFFF,&H001A263B,&H88000000,0,0,0,0,100,100,0,0,3,2,0,9,24,24,18,1
Style: Highlight,Segoe UI,20,&H00FFE050,&H00FFE050,&H00FFE050,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
'''
    events = []
    def event(start,end,style,text,layer=1):
        if 0 <= start < end <= length + .02:
            events.append(f'Dialogue: {layer},{stamp(start)},{stamp(end)},{style},,0,0,0,,{text}')
        else:
            raise ValueError(f'Invalid {style} subtitle time {start}..{end} for {length}')
    if scene.get('title'):
        title = ass_text(scene['title'])
        if frame_top:
            right=max(1,width-int(260*scale)) if disclosure else width
            title_tags=rf'{{\an4\move({int(20*scale)},{frame_top//2},{int(36*scale)},{frame_top//2},0,350)\clip(0,0,{right},{frame_top})\q2\fad(180,350)}}'
        else:
            title_tags=rf'{{\move({int(20*scale)},{int(18*scale)},{int(36*scale)},{int(30*scale)},0,350)\fad(180,350)}}'
        event(0,min(4,length),'Title',title_tags+title,3)
    if disclosure:
        label_tags=rf'{{\an6\pos({width-int(24*scale)},{frame_top//2})\clip(0,0,{width},{frame_top})\q2}}' if frame_top else ''
        event(0,length,'Label',label_tags+ass_text(disclosure),3)
    for caption in captions:
        lines = textwrap.wrap(caption['text'], width=65, break_long_words=False, break_on_hyphens=False)
        if frame_bottom:
            if len(lines)>3:
                raise ValueError('Caption exceeds three lines; split it into shorter timed phrases')
            font=min(27*scale,(frame_bottom-12*scale)/(max(1,len(lines))*1.25))
            if font<24*scale:
                raise ValueError('Caption band is too short for readable subtitles')
            caption_tags=rf'{{\an5\pos({width//2},{content_bottom+frame_bottom//2})\clip(0,{content_bottom},{width},{height})\q2\fs{font:.2f}\fad(65,65)}}'
        else:
            caption_tags=r'{\fad(65,65)}'
        event(float(caption['start']),float(caption['end']),'Caption',caption_tags+ass_text('\n'.join(lines)))
    for highlight in scene.get('highlights',[]):
        box = highlight['box']
        if len(box)!=4 or any(not math.isfinite(float(v)) for v in box):
            raise ValueError('Highlight requires finite x,y,width,height fractions')
        x,y,w,h = box
        if min(x,y)<0 or min(w,h)<=0 or x+w>1 or y+h>1:
            raise ValueError('Highlight must fit content area')
        x,y,w,h = int(x*width),frame_top+int(y*content_height),int(w*width),int(h*content_height)
        t=max(2,round(3*scale))
        drawing=f'm 0 0 l {w} 0 {w} {h} 0 {h} 0 0 m {t} {t} l {t} {h-t} {w-t} {h-t} {w-t} {t} {t} {t}'
        event(float(highlight['start']),float(highlight['end']),'Highlight',rf'{{\an7\pos({x},{y})\p1\fad(180,180)}}'+drawing,2)
    path.write_text(head+'\n'.join(events)+'\n',encoding='utf-8')


def filter_path(path):
    return Path(path).resolve().as_posix().replace(':',r'\:').replace("'",r"\'")


def render_scene(scene, voice, captions, base, output, config):
    source=(base/scene['video']).resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    top,bottom=config.get('frameTop',0),config.get('frameBottom',0)
    if any(type(v) is not int or v<0 or v%2 for v in (top,bottom)):
        raise ValueError('Frame bands must be nonnegative even integer pixel heights')
    w,total_height,fps=config.get('width',1280),config.get('height',720+top+bottom),config.get('fps',25)
    if any(not isinstance(v,int) or v<=0 for v in (w,total_height,fps)) or w%2 or total_height%2:
        raise ValueError('Invalid output dimensions/frame rate')
    h=total_height-top-bottom
    if h<=0:
        raise ValueError('Frame bands leave no content area')
    if top and top<44*w/1280:
        raise ValueError('Top band is too short for the title')
    length=duration(voice)+.5
    trim=float(scene.get('trim_start',0))
    hold=float(scene.get('hold_seconds',0))
    if trim<0 or not 0<=hold<=3:
        raise ValueError('Invalid trim_start/hold_seconds')
    available=duration(source)-trim
    if available+hold+.05 < length:
        raise ValueError(f"{scene['id']}: clip {available:.2f}s too short for narration {length:.2f}s; capture more real footage")
    target=output/f"{scene['id']}.mp4"
    receipt=output/f"{scene['id']}.receipt.json"
    fingerprint=dict(scene=scene,config=config,video_sha256=digest(source),voice_sha256=digest(voice),
                     script_sha256=digest(__file__),captions=captions)
    if target.exists() and receipt.exists():
        stored=json.loads(receipt.read_text(encoding='utf-8'))
        if stored.get('inputs')==fingerprint and stored.get('output_sha256')==digest(target):
            return target,length
    subfile=output/f"{scene['id']}.ass"
    create_ass(subfile,scene,captions,length,w,total_height,config.get('disclosure',''),top,bottom)
    filters=[]
    if scene.get('crop'):
        x,y,cw,ch=map(float,scene['crop'])
        if not all(math.isfinite(v) for v in (x,y,cw,ch)) or min(x,y)<0 or min(cw,ch)<=0 or x+cw>1 or y+ch>1:
            raise ValueError('Crop fractions must fit source frame')
        filters.append(f'crop=trunc(iw*{cw}/2)*2:trunc(ih*{ch}/2)*2:iw*{x}:ih*{y}')
    filters.extend([f'scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos',
                    f'pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x0d1421','setsar=1',f'fps={fps}'])
    if top or bottom:
        filters.append(f'pad={w}:{total_height}:0:{top}:color=0x0d1421')
    if hold:
        filters.append(f'tpad=stop_mode=clone:stop_duration={hold}')
    filters.extend([f"ass=filename='{filter_path(subfile)}'",'format=yuv420p'])
    args=['ffmpeg','-hide_banner','-loglevel','warning','-y','-ss',trim,'-i',source,'-i',voice,
          '-map','0:v:0','-map','1:a:0','-vf',','.join(filters),
          '-af','loudnorm=I=-16:TP=-1.5:LRA=7,apad','-t',length,
          '-c:v','libx264','-preset','medium','-crf',config.get('crf',22),'-pix_fmt','yuv420p',
          '-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-movflags','+faststart',target]
    run(args,output/f"{scene['id']}.render.log")
    write_json(receipt,dict(inputs=fingerprint,output_sha256=digest(target)))
    return target,length


def concatenate(clips, target):
    listing=target.with_suffix('.concat.txt')
    concat_file(listing,clips)
    run(['ffmpeg','-hide_banner','-loglevel','warning','-y','-f','concat','-safe','0','-i',listing,
         '-c','copy','-movflags','+faststart',target],target.with_suffix('.concat.log'))


def package(clips, output, chapters):
    master=output/'tutorial-master.mp4'
    concatenate(clips,master)
    limit=48_000_000
    if master.stat().st_size<=limit:
        parts=[master]
    else:
        groups,current,total=[],[],0
        for clip in clips:
            size=clip.stat().st_size
            if size>limit-500_000:
                raise ValueError(f'{clip.name} alone exceeds Telegram budget; split that chapter into shorter scenes')
            if current and total+size>limit-500_000:
                groups.append(current)
                current,total=[],0
            current.append(clip)
            total+=size
        if current:
            groups.append(current)
        parts=[]
        for i,group in enumerate(groups,1):
            part=output/f'tutorial-part-{i:02d}.mp4'
            concatenate(group,part)
            if part.stat().st_size>limit:
                raise ValueError('Unexpected mux overhead; split into smaller chapter groups')
            parts.append(part)
    verification=[]
    for part in parts:
        media=probe(part)
        run(['ffmpeg','-v','error','-xerror','-i',part,'-f','null','-'],part.with_suffix('.decode.log'))
        verification.append(dict(file=str(part),bytes=part.stat().st_size,sha256=digest(part),
                                 seconds=float(media['format']['duration']),
                                 streams=[{k:s.get(k) for k in ('codec_type','codec_name','width','height','sample_rate')} for s in media['streams']]))
    write_json(output/'delivery.json',dict(master=str(master),parts=verification,chapters=chapters))
    print(json.dumps(dict(master=str(master),parts=verification),ensure_ascii=False,indent=2))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['narration','render'])
    parser.add_argument('manifest',type=Path)
    a=parser.parse_args()
    for name in ('ffmpeg','ffprobe'):
        if not shutil.which(name):
            raise RuntimeError(f'{name} not found')
    base=a.manifest.resolve().parent
    manifest=json.loads(a.manifest.read_text(encoding='utf-8-sig'))
    output=(base/manifest.get('output','render')).resolve()
    output.mkdir(parents=True,exist_ok=True)
    scenes=manifest['scenes']
    ids=[s['id'] for s in scenes]
    if not scenes or len(set(ids))!=len(ids) or any(not re.fullmatch(r'[A-Za-z0-9_-]+',i) for i in ids):
        raise ValueError('Scene ids must be unique nonempty safe identifiers')
    clips,chapters,cursor=[],[],0.0
    config={k:v for k,v in manifest.items() if k not in ('scenes','output')}
    for scene in scenes:
        if scene.get('voice'):
            voice=(base/scene['voice']).resolve()
            captions=scene.get('subtitles',[])
        else:
            voice,captions=synthesize(scene,output)
        chapter=dict(id=scene['id'],title=scene.get('title',''),voice=str(voice),
                     voice_sha256=digest(voice),seconds=duration(voice)+.5,start=round(cursor,3))
        if a.command=='render':
            clip,length=render_scene(scene,voice,captions,base,output,config)
            clips.append(clip)
            chapter.update(video=str((base/scene['video']).resolve()),video_sha256=digest(base/scene['video']),
                           seconds=duration(clip))
        cursor+=chapter['seconds']
        chapters.append(chapter)
        write_json(output/'chapters.json',chapters)
        print(f"{scene['id']}: {chapter['seconds']:.2f}s ({a.command})",flush=True)
    if a.command=='render':
        package(clips,output,chapters)


if __name__=='__main__':
    try:
        main()
    except Exception as error:
        print(f'ERROR: {error}',file=sys.stderr)
        sys.exit(1)
