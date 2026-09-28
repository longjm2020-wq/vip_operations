import { useState } from "react";
import { Button, Input, InputNumber, Modal, Table, Tabs } from "antd";
import { collectionStockTotal, type CollectionStock } from "../../../packages/contracts/src/selection-collection";

export function CollectionStockEditor({ inventory, onChange, readOnly = false }: {
  inventory: CollectionStock[]; onChange: (inventory: CollectionStock[]) => void; readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("available");
  const production = tab === "production";
  const set = (index: number, patch: Partial<CollectionStock>) => onChange(inventory.map((item, i) => i === index ? { ...item, ...patch } : item));
  const quantity=(row:CollectionStock,index:number)=><InputNumber aria-label={row.color+row.size+(production?"做货库存":"现货库存")} disabled={readOnly} min={0} max={10000000} precision={0} value={production?row.production:row.available} onChange={value=>set(index,{[production?"production":"available"]:value ?? 0})} />;
  const date=(row:CollectionStock,index:number)=><Input type="date" aria-label={row.color+row.size+(production?"预计出货日期":"预计售罄日期")} disabled={readOnly} value={(production?row.shipDate:row.sellOutDate) || ""} onChange={event=>set(index,{[production?"shipDate":"sellOutDate"]:event.target.value || null})} />;
  return <>
    <Button onClick={() => setOpen(true)}>{collectionStockTotal(inventory)} 件 · 库存明细</Button>
    <Modal className="collection-stock-modal" title="库存明细" open={open} width={760} onCancel={() => setOpen(false)} footer={<Button type="primary" onClick={() => setOpen(false)}>完成</Button>}>
      <Tabs activeKey={tab} onChange={setTab} items={[{key:"available",label:"现货库存"},{key:"production",label:"支持做货库存"}]} />
      <p>按颜色与尺码填写；无库存填 0。{production ? "做货数量大于零时需填写预计出货日期。" : "现货数量大于零时需填写预计售罄日期。"}</p>
      <div className="collection-stock-desktop"><Table size="small" pagination={false} scroll={{x:560,y:400}} rowKey={row=>JSON.stringify([row.color,row.size])} dataSource={inventory} locale={{emptyText:"请先填写颜色和尺码"}} columns={[
        {title:"颜色",dataIndex:"color",width:100},
        {title:"尺码",dataIndex:"size",width:80},
        {title:production?"支持做货库存":"现货库存",width:160,render:(_,row,index)=>quantity(row,index)},
        {title:production?"预计出货日期":"预计售罄日期",render:(_,row,index)=>date(row,index)}
      ]} /></div>
      <div className="collection-stock-mobile">{inventory.length?inventory.map((row,index)=><section key={JSON.stringify([row.color,row.size])}>
        <strong>{row.color} · {row.size}</strong>
        <label>{production?"支持做货库存":"现货库存"}{quantity(row,index)}</label>
        <label>{production?"预计出货日期":"预计售罄日期"}{date(row,index)}</label>
      </section>):<p>请先填写颜色和尺码</p>}</div>
      <p>现货：{inventory.reduce((sum,item)=>sum+item.available,0)} 件　做货：{inventory.reduce((sum,item)=>sum+item.production,0)} 件　总库存：{collectionStockTotal(inventory)} 件</p>
    </Modal>
  </>;
}
