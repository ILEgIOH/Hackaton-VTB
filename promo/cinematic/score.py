import numpy as np, wave
SR=44100;D=31.5;N=int(SR*D);t=np.arange(N)/SR
rng=np.random.default_rng(3)
def env(a,b,x): return np.clip((x-a)/(b-a),0,1)
def sm(x): return x*x*(3-2*x)
L=np.zeros(N);R=np.zeros(N)
def add(sig,t0,pan=0.0,g=1.0):
    i=int(t0*SR);n=min(len(sig),N-i)
    if n<=0:return
    L[i:i+n]+=sig[:n]*g*(1-max(0,pan));R[i:i+n]+=sig[:n]*g*(1+min(0,pan))
def lp(x,k): # простой фильтр скользящим средним
    c=np.cumsum(np.insert(x,0,0));return (c[k:]-c[:-k])/k if k>1 else x
# дрон + пэд
amp=sm(env(0,6,t))*(0.5+0.5*sm(env(14,16,t)))*(1-sm(env(29.5,31.5,t)))
drone=(np.sin(2*np.pi*55*t)+0.5*np.sin(2*np.pi*110*t+0.3*np.sin(2*np.pi*.1*t)))*0.22
pad=0
for f,d in [(110,0),(164.8,.7),(220,-.5),(261.6,.4),(329.6,-.3)]:
    for h,gh in [(1,1),(2,.4),(3,.2)]:
        pad=pad+gh*np.sin(2*np.pi*(f*h+d)*t+ (np.sin(2*np.pi*.17*t+f)*0.6))
pad*=0.035*(0.6+0.4*np.sin(2*np.pi*.08*t))
base=(drone+pad)*amp
L+=base;R+=np.roll(base,300)
# пульс
tt=0.0;beat=0.62
bt=[]
x=4.5
while x<27.5:
    bt.append(x);x+=beat-0.2*env(4.5,15,x)
for x in bt:
    n=int(.35*SR);k=np.arange(n)/SR
    f=90*np.exp(-k*14)+38
    s=np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-k*9)*0.55
    add(s,x,0,1.0*(0.6+0.4*env(4.5,15,x)))
# рисеры + удары
def riser(t0,t1):
    n=int((t1-t0)*SR);k=np.arange(n)/SR;u=k/(t1-t0)
    ns=rng.standard_normal(n);ns=ns-lp(np.pad(ns,(0,15),'edge'),16)[:n]*0  # шум
    # свип: шум * AM по растущей частоте + тон
    sw=np.sin(2*np.pi*(200*k+ (1800*k**2/(2*(t1-t0)))))*0.15
    s=(ns*0.25*u**2+sw*u)*u
    add(s,t0,0,0.9)
def hit(t0,g=1.0,long=1.8):
    n=int(long*SR);k=np.arange(n)/SR
    f=140*np.exp(-k*3.2)+32
    body=np.sin(2*np.pi*np.cumsum(f)/SR)*np.exp(-k*1.7)*1.0
    ns=rng.standard_normal(n);ns=lp(np.pad(ns,(0,5),'edge'),6)[:n]*np.exp(-k*5)*0.6
    ring=(np.sin(2*np.pi*220*k)+.6*np.sin(2*np.pi*329.6*k)+.4*np.sin(2*np.pi*440*k))*np.exp(-k*1.4)*0.18
    add(body+ns+ring,t0,0,g)
riser(8.0,10.0);riser(12.6,15.2);riser(19.0,21.4);riser(24.8,27.2)
hit(10.0,.5);hit(15.2,1.0);hit(17.55,.45,1.2);hit(21.4,.9);hit(27.2,1.2,3.5)
# арпеджио
pent=[220,261.6,293.7,329.6,392,440,523.3,659.3]
x=15.3;i=0
while x<21.2:
    f=pent[[0,2,4,3,5,2,6,4][i%8]]
    n=int(.35*SR);k=np.arange(n)/SR
    s=(np.sin(2*np.pi*f*k)+.3*np.sin(2*np.pi*2*f*k))*np.exp(-k*12)*0.09
    add(s,x,(-.5 if i%2 else .5));x+=0.155;i+=1
# финальные колокола
for j,f in enumerate([880,1318.5,1760]):
    n=int(3.5*SR);k=np.arange(n)/SR
    add(np.sin(2*np.pi*f*k)*np.exp(-k*1.3)*0.06,27.3+j*.25,(j-1)*.5)
# мастер
fo=1-sm(env(29.8,31.5,t));L*=fo;R*=fo
m=max(abs(L).max(),abs(R).max());L/=m;R/=m
st=np.stack([L,R],1)*0.89
# мягкий лимитер
st=np.tanh(st*1.3)/np.tanh(1.3)
pcm=(st*32767).astype('<i2')
with wave.open('out/score.wav','wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes(pcm.tobytes())
print('ok',D)
