import { useState } from 'react';
import './Navbar.css';

const imgLogo = "http://localhost:3845/assets/b3e0cc9a7907e642530853d1ab9b2a147e8f9e11.png";
const imgSearch = "http://localhost:3845/assets/3b7bb4f9bc22fda1f4fc96398f42fb95385e503c.svg";
const imgUpload = "http://localhost:3845/assets/c6ea86dc69f9478038f2bf0a3473e2e421c4bbfc.svg";
const imgProfile = "http://localhost:3845/assets/1af8d994141246153693a599c017705356b95de1.svg";
const imgPerson = "http://localhost:3845/assets/627d492e7c95cfbccc4574266f4dce2d0ee267c5.svg";

function Navbar({ activeTab, setActiveTab }) {

  return (
    <div className="navbar">
      <div className="navbar-logo" style={{ backgroundImage: `url('${imgLogo}')` }} />
      
      <div className="navbar-search">
        <div 
          className={`search-tab ${activeTab === 'upload' ? 'active' : ''}`}
          onClick={() => setActiveTab('upload')}
        >
          <img src={imgUpload} alt="" className="tab-icon" />
          <span>Upload</span>
        </div>
        <div 
          className={`search-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <img src={imgSearch} alt="" className="tab-icon" />
          <span>Agents Dashboard</span>
        </div>
      </div>
      
      <div className="navbar-profile">
        <div className="profile-circle">
          <img src={imgPerson} alt="" className="profile-icon" />
        </div>
      </div>
    </div>
  );
}

export default Navbar;