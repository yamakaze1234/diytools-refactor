import hashlib
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from openpyxl import Workbook
from cost_file import read_costs

class CostFileTests(unittest.TestCase):
 def read(self,rows):
  with TemporaryDirectory() as d:
   path=Path(d)/'cost.xlsx';w=Workbook();w.active.title='库存数据'
   for row in rows:w.active.append(row)
   w.save(path);w.close();before=hashlib.sha256(path.read_bytes()).hexdigest()
   result=read_costs({'path':str(path),'sheet':'库存数据','goodsColumn':1,'taxColumn':2})
   self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(),before)
   return result
 def test_readonly_two_columns_errors_and_duplicates(self):
  r=self.read([['goods_id','含税成本','unused'],['9007199254740993',23.5,'private'],[1,0],[1,0],[2,'#VALUE!'],[3,None]])
  self.assertEqual(r['rows'],[{'goods_id':'9007199254740993','tax':23.5},{'goods_id':'1','tax':0}]);self.assertEqual(r['invalidCount'],1)
 def test_cache_matches_content_and_does_not_share_mutable_rows(self):
  with TemporaryDirectory() as d:
   path=Path(d)/'cost.xlsx';settings={'path':str(path),'sheet':'库存数据','goodsColumn':1,'taxColumn':2}
   def save(price):
    w=Workbook();w.active.title='库存数据';w.active.append(['goods_id','含税成本']);w.active.append([1,price]);w.save(path);w.close()
   save(5);first=read_costs(settings);self.assertFalse(first['cacheHit']);first['rows'][0]['tax']=99
   second=read_costs(settings);self.assertTrue(second['cacheHit']);self.assertEqual(second['rows'][0]['tax'],5)
   save(6);third=read_costs(settings);self.assertFalse(third['cacheHit']);self.assertEqual(third['rows'][0]['tax'],6)
 def test_conflicting_duplicate(self):
  with self.assertRaisesRegex(ValueError,'不同成本'):self.read([['goods_id','含税成本'],[1,5],[1,6]])
 def test_imprecise_id(self):
  with self.assertRaisesRegex(ValueError,'不精确'):self.read([['goods_id','含税成本'],[9007199254740994,5]])
 def test_bad_header_and_empty(self):
  for rows in [[['id','price'],[1,5]],[['goods_id','含税成本']]]:
   with self.assertRaises(ValueError):self.read(rows)
 def test_invalid_range(self):
  with self.assertRaises(ValueError):self.read([['goods_id','含税成本'],[1,-1]])

if __name__=='__main__':unittest.main()
