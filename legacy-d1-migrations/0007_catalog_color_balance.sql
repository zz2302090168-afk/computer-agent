-- 补齐六类外观配件，每类保留10白10黑；不更改整机引用及会话。
--> statement-breakpoint
DELETE FROM products WHERE id='real-gpu-1' AND name='GeForce RTX 3060 VENTUS 2X 12G OC' AND price=1700;
--> statement-breakpoint
DELETE FROM products WHERE id='real-gpu-3' AND name='GeForce RTX 4060 Ti VENTUS 2X BLACK 8G OC' AND price=2400;
--> statement-breakpoint
DELETE FROM products WHERE id='real-gpu-4' AND name='GeForce RTX 4060 Ti VENTUS 2X BLACK 16G OC' AND price=2800;
--> statement-breakpoint
DELETE FROM products WHERE id='real-gpu-5' AND name='GeForce RTX 4070 VENTUS 2X 12G OC' AND price=3300;
--> statement-breakpoint
DELETE FROM products WHERE id='real-gpu-7' AND name='GeForce RTX 4070 Ti SUPER 16G VENTUS 3X OC' AND price=4900;
--> statement-breakpoint
DELETE FROM products WHERE id='real-gpu-9' AND name='GeForce RTX 4090 VENTUS 3X 24G OC' AND price=13000;
--> statement-breakpoint
DELETE FROM products WHERE id='real-gpu-11' AND name='GeForce RTX 5060 Ti 8G VENTUS 2X OC PLUS' AND price=2700;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-2' AND name='FURY Beast KF432C16BBK2/64' AND price=690;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-4' AND name='FURY Beast KF436C18BBK2/64' AND price=750;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-5' AND name='FURY Beast KF432C16BBAK2/16' AND price=270;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-6' AND name='FURY Beast KF432C16BBAK2/32' AND price=450;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-7' AND name='FURY Beast KF436C18BBAK2/32' AND price=490;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-8' AND name='FURY Beast KF552C36BBEK2-16' AND price=320;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-10' AND name='FURY Beast KF556C36BBEK2-16' AND price=350;
--> statement-breakpoint
DELETE FROM products WHERE id='real-memory-12' AND name='FURY Beast KF560C36BBEK2-16' AND price=380;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-1' AND name='B550 A PRO' AND price=650;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-3' AND name='MPG B550 GAMING PLUS' AND price=750;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-5' AND name='MAG B550M MORTAR WIFI' AND price=850;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-8' AND name='B650 GAMING PLUS WIFI' AND price=1050;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-10' AND name='MAG B650M MORTAR WIFI' AND price=1250;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-12' AND name='PRO X670 P WIFI' AND price=1800;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-14' AND name='MPG X670E CARBON WIFI' AND price=2900;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-16' AND name='B850 GAMING PLUS WIFI' AND price=1500;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-18' AND name='PRO X870 P WIFI' AND price=1800;
--> statement-breakpoint
DELETE FROM products WHERE id='real-motherboard-19' AND name='MAG X870 TOMAHAWK WIFI' AND price=2300;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-0' AND name='RM550x (2021)' AND price=605;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-2' AND name='RM750x (2021)' AND price=825;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-3' AND name='RM850x (2021)' AND price=935;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-4' AND name='RM1000x (2021)' AND price=1100;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-10' AND name='CX650M (2021)' AND price=390;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-12' AND name='SF750 (2024)' AND price=1125;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-13' AND name='SF850 (2024)' AND price=1275;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-14' AND name='SF1000 (2024)' AND price=1500;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-15' AND name='RM650 (2021)' AND price=585;
--> statement-breakpoint
DELETE FROM products WHERE id='real-psu-16' AND name='RM750 (2021)' AND price=675;
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-gpu-20','gpu','MSI 微星','GeForce RTX 5060 8G VENTUS 2X OC WHITE','白色',2400,'{"power":145,"recommendedPsu":550,"length":197,"thickness":41,"connector":"8pin","connectors":1,"source":"https://www.msi.com/Graphics-Card/GeForce-RTX-5060-8G-VENTUS-2X-OC-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-gpu-21','gpu','MSI 微星','GeForce RTX 5060 8G GAMING TRIO OC WHITE','白色',2600,'{"power":155,"recommendedPsu":550,"length":300,"thickness":44,"connector":"8pin","connectors":1,"source":"https://www.msi.com/Graphics-Card/GeForce-RTX-5060-8G-GAMING-TRIO-OC-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-gpu-22','gpu','MSI 微星','GeForce RTX 5060 Ti 8G GAMING TRIO OC WHITE','白色',3000,'{"power":180,"recommendedPsu":600,"length":300,"thickness":44,"connector":"16pin","connectors":1,"source":"https://www.msi.com/Graphics-Card/GeForce-RTX-5060-Ti-8G-GAMING-TRIO-OC-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-gpu-23','gpu','MSI 微星','GeForce RTX 5060 Ti 16G GAMING TRIO OC WHITE','白色',3600,'{"power":180,"recommendedPsu":600,"length":300,"thickness":44,"connector":"16pin","connectors":1,"source":"https://www.msi.com/Graphics-Card/GeForce-RTX-5060-Ti-16G-GAMING-TRIO-OC-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-gpu-24','gpu','MSI 微星','GeForce RTX 5070 12G GAMING TRIO OC WHITE','白色',4600,'{"power":250,"recommendedPsu":650,"length":338,"thickness":50,"connector":"16pin","connectors":1,"source":"https://www.msi.com/Graphics-Card/GeForce-RTX-5070-12G-GAMING-TRIO-OC-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-gpu-25','gpu','MSI 微星','GeForce RTX 5070 Ti 16G GAMING TRIO OC WHITE','白色',6200,'{"power":300,"recommendedPsu":750,"length":338,"thickness":50,"connector":"16pin","connectors":1,"source":"https://www.msi.com/Graphics-Card/GeForce-RTX-5070-Ti-16G-GAMING-TRIO-OC-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-gpu-26','gpu','MSI 微星','GeForce RTX 5080 16G GAMING TRIO OC WHITE','白色',9600,'{"power":360,"recommendedPsu":850,"length":338,"thickness":50,"connector":"16pin","connectors":1,"source":"https://www.msi.com/Graphics-Card/GeForce-RTX-5080-16G-GAMING-TRIO-OC-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-20','memory','Kingston 金士顿','FURY Beast KF560C36BWEK2-64','白色',1190,'{"ddr":"DDR5","capacity":64,"sticks":2,"source":"https://www.kingston.com/datasheets/KF560C36BWEK2-64.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-21','memory','Kingston 金士顿','FURY Beast KF560C36BWEAK2-64','白色',1290,'{"ddr":"DDR5","capacity":64,"sticks":2,"source":"https://www.kingston.com/datasheets/KF560C36BWEAK2-64.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-22','memory','Kingston 金士顿','FURY Beast KF560C30BWK2-32','白色',690,'{"ddr":"DDR5","capacity":32,"sticks":2,"source":"https://www.kingston.com/datasheets/KF560C30BWK2-32.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-23','memory','Kingston 金士顿','FURY Beast KF560C30BWAK2-32','白色',750,'{"ddr":"DDR5","capacity":32,"sticks":2,"source":"https://www.kingston.com/datasheets/KF560C30BWAK2-32.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-24','memory','Kingston 金士顿','FURY Beast KF552C40BWK2-32','白色',520,'{"ddr":"DDR5","capacity":32,"sticks":2,"source":"https://www.kingston.com/datasheets/KF552C40BWK2-32.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-25','memory','Kingston 金士顿','FURY Beast KF556C40BWK2-32','白色',560,'{"ddr":"DDR5","capacity":32,"sticks":2,"source":"https://www.kingston.com/datasheets/KF556C40BWK2-32.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-26','memory','Kingston 金士顿','FURY Beast KF564C32BWK2-32','白色',760,'{"ddr":"DDR5","capacity":32,"sticks":2,"source":"https://www.kingston.com/datasheets/KF564C32BWK2-32.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-memory-27','memory','Kingston 金士顿','FURY Beast KF564C32BWAK2-32','白色',820,'{"ddr":"DDR5","capacity":32,"sticks":2,"source":"https://www.kingston.com/datasheets/KF564C32BWAK2-32.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-20','motherboard','ASRock 华擎','B850 Steel Legend WiFi','白色',1599,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"ATX","m2":true,"biosVerified":false,"source":"https://www.asrock.com/mb/AMD/B850%20Steel%20Legend%20WiFi/","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-21','motherboard','ASRock 华擎','B850M Steel Legend WiFi','白色',1399,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"mATX","m2":true,"biosVerified":false,"source":"https://www.asrock.com/mb/AMD/B850M%20Steel%20Legend%20WiFi/","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-22','motherboard','ASRock 华擎','B650 Steel Legend WiFi','白色',1299,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"ATX","m2":true,"biosVerified":false,"source":"https://www.asrock.com/mb/AMD/B650%20Steel%20Legend%20WiFi/","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-23','motherboard','GIGABYTE 技嘉','B650 AORUS ELITE AX ICE','白色',1299,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"ATX","m2":true,"biosVerified":false,"source":"https://www.gigabyte.com/Motherboard/B650-AORUS-ELITE-AX-ICE/sp","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-24','motherboard','GIGABYTE 技嘉','B650M AORUS ELITE AX ICE','白色',1199,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"mATX","m2":true,"biosVerified":false,"source":"https://www.gigabyte.com/Motherboard/B650M-AORUS-ELITE-AX-ICE-rev-1x/sp","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-25','motherboard','GIGABYTE 技嘉','B850 AORUS ELITE WIFI7 ICE','白色',1699,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"ATX","m2":true,"biosVerified":false,"source":"https://www.gigabyte.com/Motherboard/B850-AORUS-ELITE-WIFI7-ICE-rev-1x/sp","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-26','motherboard','GIGABYTE 技嘉','B850M AORUS ELITE WIFI6E ICE','白色',1399,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"mATX","m2":true,"biosVerified":false,"source":"https://www.gigabyte.com/Motherboard/B850M-AORUS-ELITE-WIFI6E-ICE-rev-1x/sp","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-27','motherboard','GIGABYTE 技嘉','X870 AORUS ELITE WIFI7 ICE','白色',2199,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"ATX","m2":true,"biosVerified":false,"source":"https://www.gigabyte.com/Motherboard/X870-AORUS-ELITE-WIFI7-ICE-rev-10-11/sp","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-28','motherboard','GIGABYTE 技嘉','B850 EAGLE ICE','白色',999,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"ATX","m2":true,"biosVerified":false,"source":"https://www.gigabyte.com/Motherboard/B850-EAGLE-ICE/sp","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-motherboard-29','motherboard','GIGABYTE 技嘉','B850 EAGLE WIFI7 ICE','白色',1199,'{"socket":"AM5","ddr":"DDR5","ramSlots":4,"form":"ATX","m2":true,"biosVerified":false,"source":"https://www.gigabyte.com/Motherboard/B850-EAGLE-WIFI7-ICE/sp","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-20','psu','CORSAIR 美商海盗船','RM750e WHITE (2025)','白色',699,'{"watts":750,"form":"ATX","length":140,"connectorCounts":{"16pin":1},"source":"https://www.corsair.com/us/en/p/psu/cp-9020292-na/rme-series-rm750e-fully-modular-low-noise-atx-power-supply-white-na-cp-9020292-na","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-21','psu','CORSAIR 美商海盗船','RM850e WHITE (2025)','白色',799,'{"watts":850,"form":"ATX","length":140,"connectorCounts":{"16pin":1},"source":"https://www.corsair.com/us/en/p/psu/cp-9020293-na/rme-series-rm850e-fully-modular-low-noise-atx-power-supply-white-na-cp-9020293-na","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-22','psu','CORSAIR 美商海盗船','RM1000e WHITE (2025)','白色',999,'{"watts":1000,"form":"ATX","length":140,"connectorCounts":{"16pin":1},"source":"https://www.corsair.com/us/en/p/psu/cp-9020294-na/rme-series-rm1000e-fully-modular-low-noise-atx-power-supply-white-na-cp-9020294-na","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-23','psu','DeepCool 九州风神','PN650M WH','白色',499,'{"watts":650,"form":"ATX","length":140,"connectorCounts":{"16pin":1},"source":"https://www.deepcool.com/products/PowerSupplyUnits/powersupplyunits/2024/19528.shtml","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-24','psu','DeepCool 九州风神','PN750M WH','白色',599,'{"watts":750,"form":"ATX","length":140,"connectorCounts":{"16pin":1},"source":"https://www.deepcool.com/products/PowerSupplyUnits/powersupplyunits/2024/19529.shtml","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-25','psu','DeepCool 九州风神','PN850M WH','白色',699,'{"watts":850,"form":"ATX","length":140,"connectorCounts":{"16pin":1},"source":"https://www.deepcool.com/products/PowerSupplyUnits/powersupplyunits/2024/19530.shtml","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-26','psu','DeepCool 九州风神','PL550D WH','白色',329,'{"watts":550,"form":"ATX","source":"https://www.deepcool.com/download/pdf/PL_D.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-27','psu','DeepCool 九州风神','PL650D WH','白色',379,'{"watts":650,"form":"ATX","source":"https://www.deepcool.com/download/pdf/PL_D.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-28','psu','DeepCool 九州风神','PL750D WH','白色',429,'{"watts":750,"form":"ATX","source":"https://www.deepcool.com/download/pdf/PL_D.pdf","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
--> statement-breakpoint
INSERT OR IGNORE INTO products(id,category,brand,name,color,price,specs,demo) VALUES('real-psu-29','psu','MSI 微星','MAG A850GL PCIE5 WHITE','白色',799,'{"watts":850,"form":"ATX","length":140,"connectorCounts":{"16pin":1},"source":"https://us.msi.com/Power-Supply/MAG-A850GL-PCIE5-WHITE/Specification","checkedAt":"2026-09-09","priceBasis":"merchant-authored"}',0);
