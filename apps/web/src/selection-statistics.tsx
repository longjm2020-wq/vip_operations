import type { SelectionLayout } from "../../../packages/contracts/src/selection-layout";
import { Button, Checkbox, Divider, Popover, Radio } from "antd";
import { UnorderedListOutlined } from "@ant-design/icons";

const labels = {sum:"求和",average:"平均值",count:"计数",numeric:"数值计数",max:"最大值",min:"最小值"};
type Metric = keyof typeof labels;
export function SelectionStatistics({values,settings,onChange}:{values:unknown[];settings:SelectionLayout["statistics"];onChange:(value:SelectionLayout["statistics"])=>void}) {
  const {visible,format}=settings;
  const setVisible=(value:Metric[]|((previous:Metric[])=>Metric[]))=>onChange({...settings,visible:typeof value==="function"?value(visible):value});
  const setFormat=(format:SelectionLayout["statistics"]["format"])=>onChange({...settings,format});
  const filled=values.filter(value=>value!==null && value!==undefined && String(value).trim()!=="");
  const numbers=filled.filter(value=>typeof value==="number" || (typeof value==="string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))).map(Number).filter(Number.isFinite);
  const sum=numbers.reduce((total,value)=>total+value,0);
  const stats:Record<Metric,number|null>={sum:numbers.length?sum:null,average:numbers.length?sum/numbers.length:null,count:filled.length,numeric:numbers.length,max:numbers.length?numbers.reduce((a,b)=>Math.max(a,b)):null,min:numbers.length?numbers.reduce((a,b)=>Math.min(a,b)):null};
  const display=(value:number|null):string=>{
    if(value===null || !Number.isFinite(value))return "—";
    if(format==="chinese" && Math.abs(value)>=10000)return `${Number((value/10000).toFixed(4))}万`;
    const text=Number(value.toFixed(6)).toString();
    if(format==="thousands")return value.toLocaleString("en-US",{maximumFractionDigits:6});
    if(format==="tenThousands"){const [integer,decimal]=text.split(".");return integer.replace(/\B(?=(\d{4})+(?!\d))/g,",")+(decimal?"."+decimal:"");}
    return text;
  };
  const content=<div className="selection-statistics-menu">
    <Button type="text" block onClick={()=>setVisible([])}>无</Button>
    <Divider style={{margin:"8px 0"}}/>
    {(Object.keys(labels) as Metric[]).map(key=><label key={key}><Checkbox checked={visible.includes(key)} onChange={event=>setVisible(current=>event.target.checked?[...current,key]:current.filter(item=>item!==key))}>{labels[key]}</Checkbox><span>{display(stats[key])}</span></label>)}
    <Divider style={{margin:"8px 0"}}/>
    <Radio.Group value={format} onChange={event=>setFormat(event.target.value)} options={[{value:"plain",label:"普通数字"},{value:"chinese",label:"中文单位分隔"},{value:"thousands",label:"千分位分隔"},{value:"tenThousands",label:"万位分隔"}]} />
  </div>;
  return <div className="selection-statistics" aria-label="选区统计">
    <span aria-live="polite">{visible.map(key=><span key={key}>{labels[key]}={display(stats[key])}</span>)}</span>
    <Popover trigger="click" placement="topRight" content={content}><Button type="text" size="small" aria-label="设置选区统计" title="选区统计" icon={<UnorderedListOutlined/>}/></Popover>
  </div>;
}
