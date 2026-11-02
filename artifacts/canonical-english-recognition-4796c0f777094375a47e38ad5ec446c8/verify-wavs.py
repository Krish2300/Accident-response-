import glob, hashlib, json, math, os, struct, sys, wave
D=sys.argv[1]
phrases=[
 'Hello, can you hear me?', 'I need help, please.', 'I am calling from the main road.',
 'The nearest landmark is the bus station.', 'The house number is twenty-four.',
 'Please send the information to the operator.', 'I will stay here and answer your questions.'
]
rows=[]
for i, phrase in enumerate(phrases, 1):
    name=f'sample-{i:02d}.wav'; p=os.path.join(D,name)
    if not os.path.isfile(p) or os.path.getsize(p)==0: raise SystemExit(f'missing/empty expected WAV: {p}')
    with wave.open(p,'rb') as w:
        channels, rate, width, frames=w.getnchannels(),w.getframerate(),w.getsampwidth(),w.getnframes()
        raw=w.readframes(frames)
        if len(raw)!=frames*channels*width: raise SystemExit(f'incomplete decode: {p}')
        if (channels,rate,width)!=(1,22050,2) or frames<=0: raise SystemExit(f'unexpected format: {p}')
        vals=struct.unpack('<'+'h'*(len(raw)//2),raw)
    rms=math.sqrt(sum(v*v for v in vals)/len(vals)); peak=max(map(abs,vals),default=0)
    if rms<=0 or peak<=0: raise SystemExit(f'silent audio: {p}')
    rows.append({'number':i,'file':name,'path':p,'expected':phrase,'bytes':os.path.getsize(p),'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest(),'encoding':'PCM S16LE','sampleRateHz':rate,'channels':channels,'bitsPerSample':width*8,'frames':frames,'durationSeconds':round(frames/rate,6),'rms':round(rms,2),'peak':peak,'decoded':True,'nonSilent':True})
if len(glob.glob(os.path.join(D,'sample-*.wav')))!=7: raise SystemExit('unexpected extra or missing sample-*.wav files')
with open(os.path.join(D,'audio-metadata.json'),'w') as f: json.dump(rows,f,indent=2); f.write('\n')
print(json.dumps(rows,indent=2))
